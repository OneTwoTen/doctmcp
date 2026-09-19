import type { Database } from "bun:sqlite";
import {
  type DeviceCredential,
  deviceCredentialIdSchema,
  deviceCredentialSchema,
  deviceIdSchema,
} from "@doctmcp/schemas";
import {
  constantTimeEqualHex,
  DeviceCredentialError,
  type DeviceCredentialRepository,
} from "../device-credential";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

type CredentialRow = {
  credential_id: string;
  device_id: string;
  version: number;
  secret_digest: string;
  created_at_ms: number;
  state: "active" | "revoked";
  revoked_at_ms: number | null;
};

function fail(
  code: ConstructorParameters<typeof DeviceCredentialError>[0],
  message: string,
): never {
  throw new DeviceCredentialError(code, message);
}

function parseDevice(value: string): string {
  const parsed = deviceIdSchema.safeParse(value);
  if (!parsed.success)
    return fail("INVALID_CREDENTIAL_INPUT", "deviceId không hợp lệ.");
  return parsed.data;
}

function parseCredential(value: string): string {
  const parsed = deviceCredentialIdSchema.safeParse(value);
  if (!parsed.success)
    return fail("INVALID_CREDENTIAL_INPUT", "credentialId không hợp lệ.");
  return parsed.data;
}

function parseDigest(value: string): string {
  if (!DIGEST_PATTERN.test(value)) {
    return fail("INVALID_CREDENTIAL_INPUT", "Credential digest không hợp lệ.");
  }
  return value;
}

function parseVersion(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    return fail("INVALID_CREDENTIAL_INPUT", "Credential version không hợp lệ.");
  }
  return value;
}

function timestamp(value: Date): number {
  const ms = value.getTime();
  if (!Number.isFinite(ms))
    return fail("INVALID_CLOCK", "Credential clock không hợp lệ.");
  return ms;
}

function snapshot(row: CredentialRow): DeviceCredential {
  const parsed = deviceCredentialSchema.safeParse({
    credentialId: row.credential_id,
    deviceId: row.device_id,
    version: row.version,
    state: row.state,
    createdAt: new Date(row.created_at_ms),
    ...(row.revoked_at_ms === null
      ? {}
      : { revokedAt: new Date(row.revoked_at_ms) }),
  });
  if (!parsed.success) throw new Error("SQLite credential row không hợp lệ.");
  return Object.freeze(parsed.data);
}

/** Shared, migrated SQLite connection. No raw secret is accepted or stored. */
export class SqliteDeviceCredentialRepository
  implements DeviceCredentialRepository
{
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  #get(deviceId: string): CredentialRow | null {
    return this.#database
      .query("SELECT * FROM device_credentials WHERE device_id = ?1")
      .get(deviceId) as CredentialRow | null;
  }

  #requireUnused(credentialId: string): void {
    const used = this.#database
      .query(
        "SELECT 1 FROM used_device_credential_ids WHERE credential_id = ?1",
      )
      .get(credentialId);
    if (used) fail("CREDENTIAL_ID_CONFLICT", "credentialId đã được sử dụng.");
  }

  async issue(input: {
    readonly deviceId: string;
    readonly credentialId: string;
    readonly secretDigest: string;
    readonly createdAt: Date;
  }): Promise<DeviceCredential> {
    const deviceId = parseDevice(input.deviceId);
    const credentialId = parseCredential(input.credentialId);
    const digest = parseDigest(input.secretDigest);
    const createdAtMs = timestamp(input.createdAt);
    return this.#database
      .transaction(() => {
        const existing = this.#get(deviceId);
        if (existing?.state === "active") {
          return fail(
            "CREDENTIAL_ALREADY_EXISTS",
            "Device đã có credential active.",
          );
        }
        this.#requireUnused(credentialId);
        const version = (existing?.version ?? 0) + 1;
        this.#database
          .query(
            "INSERT INTO used_device_credential_ids (credential_id, device_id) VALUES (?1, ?2)",
          )
          .run(credentialId, deviceId);
        this.#database
          .query(`INSERT INTO device_credentials
        (device_id, credential_id, version, secret_digest, created_at_ms, state, revoked_at_ms)
        VALUES (?1, ?2, ?3, ?4, ?5, 'active', NULL)
        ON CONFLICT(device_id) DO UPDATE SET
          credential_id = excluded.credential_id, version = excluded.version,
          secret_digest = excluded.secret_digest, created_at_ms = excluded.created_at_ms,
          state = 'active', revoked_at_ms = NULL`)
          .run(deviceId, credentialId, version, digest, createdAtMs);
        const row = this.#get(deviceId);
        if (!row) throw new Error("Credential issue không thể đọc lại.");
        return snapshot(row);
      })
      .immediate();
  }

  async getActive(deviceId: string): Promise<DeviceCredential | null> {
    const row = this.#get(parseDevice(deviceId));
    return row?.state === "active" ? snapshot(row) : null;
  }

  async verify(
    deviceId: string,
    secretDigest: string,
  ): Promise<DeviceCredential | null> {
    const row = this.#get(parseDevice(deviceId));
    const digest = parseDigest(secretDigest);
    return row?.state === "active" &&
      constantTimeEqualHex(row.secret_digest, digest)
      ? snapshot(row)
      : null;
  }

  async revoke(input: {
    readonly deviceId: string;
    readonly expectedCredentialId: string;
    readonly expectedVersion: number;
    readonly revokedAt: Date;
  }): Promise<DeviceCredential | null> {
    const deviceId = parseDevice(input.deviceId);
    const credentialId = parseCredential(input.expectedCredentialId);
    const version = parseVersion(input.expectedVersion);
    const revokedAtMs = timestamp(input.revokedAt);
    return this.#database
      .transaction(() => {
        const current = this.#get(deviceId);
        if (
          !current ||
          current.state !== "active" ||
          current.credential_id !== credentialId ||
          current.version !== version
        )
          return null;
        if (revokedAtMs < current.created_at_ms) {
          return fail("INVALID_CLOCK", "revokedAt không được trước createdAt.");
        }
        const changed = this.#database
          .query(`UPDATE device_credentials
        SET state = 'revoked', revoked_at_ms = ?1
        WHERE device_id = ?2 AND credential_id = ?3 AND version = ?4 AND state = 'active'`)
          .run(revokedAtMs, deviceId, credentialId, version);
        if (changed.changes !== 1) return null;
        const row = this.#get(deviceId);
  }

  async rotate(input: {
    readonly deviceId: string;
    readonly expectedCredentialId: string;
    readonly expectedVersion: number;
    readonly credentialId: string;
    readonly secretDigest: string;
    readonly rotatedAt: Date;
  }): Promise<DeviceCredential> {
    const deviceId = parseDevice(input.deviceId);
    const expectedId = parseCredential(input.expectedCredentialId);
    const expectedVersion = parseVersion(input.expectedVersion);
    const credentialId = parseCredential(input.credentialId);
    const digest = parseDigest(input.secretDigest);
    const rotatedAtMs = timestamp(input.rotatedAt);
    return this.#database.transaction(() => {
      const current = this.#get(deviceId);
      if (
        current?.state !== "active" ||
        current.credential_id !== expectedId || current.version !== expectedVersion
      ) return fail("CREDENTIAL_UNAVAILABLE", "Credential không khả dụng.");
      this.#requireUnused(credentialId);
      if (rotatedAtMs < current.created_at_ms) {
        return fail("INVALID_CLOCK", "rotatedAt không được trước createdAt.");
      }
      this.#database.query(
        "INSERT INTO used_device_credential_ids (credential_id, device_id) VALUES (?1, ?2)",
      ).run(credentialId, deviceId);
      const changed = this.#database.query(`UPDATE device_credentials SET
        credential_id = ?1, version = ?2, secret_digest = ?3,
        created_at_ms = ?4, state = 'active', revoked_at_ms = NULL
        WHERE device_id = ?5 AND credential_id = ?6 AND version = ?7 AND state = 'active'`)
        .run(credentialId, current.version + 1, digest, rotatedAtMs,
          deviceId, expectedId, expectedVersion);
      if (changed.changes !== 1) {
        return fail("CREDENTIAL_UNAVAILABLE", "Credential không khả dụng.");
      }
      const row = this.#get(deviceId);
      if (!row) throw new Error("Credential rotate không thể đọc lại.");
      return snapshot(row);
    }).immediate();
  }
}
