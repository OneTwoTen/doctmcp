import type { Database } from "bun:sqlite";
import {
  type CreateDeviceInput,
  createDeviceInputSchema,
  type Device,
  type DeviceMetadata,
  deviceIdSchema,
  ownerIdSchema,
  type UpdateDeviceInput,
  updateDeviceInputSchema,
} from "@doctmcp/schemas";
import {
  type DeviceRepository,
  DeviceRepositoryError,
  type InMemoryDeviceRepositoryOptions,
} from "../device-repository";

/** Persistent fields only: online state and WebSocket sessions remain in-memory. */
interface DeviceRow {
  device_id: string;
  owner_id: string;
  device_name: string;
  platform: string;
  app_version: string | null;
  runtime_version: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

function parseOwnerId(value: string): string {
  const parsed = ownerIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new DeviceRepositoryError(
      "INVALID_DEVICE_INPUT",
      "ownerId không hợp lệ.",
    );
  }
  return parsed.data;
}

function parseDeviceId(value: string): string {
  const parsed = deviceIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new DeviceRepositoryError(
      "INVALID_DEVICE_ID",
      "deviceId không hợp lệ.",
    );
  }
  return parsed.data;
}

function snapshot(row: DeviceRow): Device {
  const metadata: DeviceMetadata = Object.freeze({
    platform: row.platform,
    ...(row.app_version === null ? {} : { appVersion: row.app_version }),
    ...(row.runtime_version === null
      ? {}
      : { runtimeVersion: row.runtime_version }),
  });
  return Object.freeze({
    deviceId: row.device_id,
    ownerId: row.owner_id,
    deviceName: row.device_name,
    metadata,
    createdAt: new Date(row.created_at_ms),
    updatedAt: new Date(row.updated_at_ms),
  });
}

/**
 * Uses the shared migrated connection; a future pairing adapter must use this
 * very connection within its own atomic claim transaction (M6.5).
 * The caller owns the database handle and closes it after repository consumers.
 */
export class SqliteDeviceRepository implements DeviceRepository {
  readonly #database: Database;
  readonly #generateDeviceId: () => string;
  readonly #now: () => Date;

  constructor(
    database: Database,
    options: InMemoryDeviceRepositoryOptions = {},
  ) {
    this.#database = database;
    this.#generateDeviceId =
      options.generateDeviceId ?? (() => globalThis.crypto.randomUUID());
    this.#now = options.now ?? (() => new Date());
  }

  async create(input: CreateDeviceInput): Promise<Device> {
    return this.createInTransaction(this.#database, input);
  }

  /**
   * Synchronous storage-only entrypoint for an enclosing SQLite pairing claim.
   * Reject a different connection: the device insert and session update must
   * commit or roll back as one transaction. Domain/service only uses create().
   */
  createInTransaction(database: Database, input: CreateDeviceInput): Device {
    if (database !== this.#database) {
      throw new Error(
        "Pairing and device repositories must share SQLite connection.",
      );
    }
    const parsed = createDeviceInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new DeviceRepositoryError(
        "INVALID_DEVICE_INPUT",
        "Device input không hợp lệ.",
      );
    }
    const deviceId = parseDeviceId(this.#generateDeviceId());
    // Match the in-memory contract: detect duplicates before consulting the clock.
    if (this.#findById(deviceId)) {
      throw new DeviceRepositoryError(
        "DEVICE_ALREADY_EXISTS",
        "deviceId đã tồn tại.",
      );
    }

    const nowMs = this.#readNow();
    const result = this.#database
      .query(`INSERT INTO devices (
        device_id, owner_id, device_name, platform, app_version,
        runtime_version, created_at_ms, updated_at_ms
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT(device_id) DO NOTHING`)
      .run(
        deviceId,
        parsed.data.ownerId,
        parsed.data.deviceName,
        parsed.data.metadata.platform,
        parsed.data.metadata.appVersion ?? null,
        parsed.data.metadata.runtimeVersion ?? null,
        nowMs,
        nowMs,
      );

    // SQLite's unique primary key also covers concurrent writers/connections.
    if (result.changes === 0) {
      throw new DeviceRepositoryError(
        "DEVICE_ALREADY_EXISTS",
        "deviceId đã tồn tại.",
      );
    }
    const created = this.#findById(deviceId);
    if (!created) throw new Error("Device insert không thể đọc lại.");
    return snapshot(created);
  }

  async getById(deviceId: string): Promise<Device | null> {
    const row = this.#findById(parseDeviceId(deviceId));
    return row ? snapshot(row) : null;
  }

  async getForOwner(ownerId: string, deviceId: string): Promise<Device | null> {
    const row = this.#findForOwner(
      parseOwnerId(ownerId),
      parseDeviceId(deviceId),
    );
    return row ? snapshot(row) : null;
  }

  async listByOwnerId(ownerId: string): Promise<readonly Device[]> {
    const rows = this.#database
      .query(
        `SELECT * FROM devices WHERE owner_id = ?1
         ORDER BY created_at_ms ASC, device_id ASC`,
      )
      .all(parseOwnerId(ownerId)) as DeviceRow[];
    return Object.freeze(rows.map(snapshot));
  }

  async updateForOwner(
    ownerId: string,
    deviceId: string,
    patch: UpdateDeviceInput,
  ): Promise<Device | null> {
    const owner = parseOwnerId(ownerId);
    const id = parseDeviceId(deviceId);
    const parsed = updateDeviceInputSchema.safeParse(patch);
    if (!parsed.success) {
      throw new DeviceRepositoryError(
        "INVALID_DEVICE_INPUT",
        "Device update không hợp lệ.",
      );
    }
    const row = this.#findForOwner(owner, id);
    if (!row) return null;

    const nowMs = this.#readNow();
    if (nowMs < row.updated_at_ms) {
      throw new DeviceRepositoryError(
        "INVALID_CLOCK",
        "Clock không được đi lùi so với updatedAt hiện tại.",
      );
    }
    const metadata = parsed.data.metadata;
    const result = this.#database
      .query(`UPDATE devices SET
        device_name = ?1, platform = ?2, app_version = ?3,
        runtime_version = ?4, updated_at_ms = ?5
        WHERE owner_id = ?6 AND device_id = ?7 AND updated_at_ms <= ?5`)
      .run(
        parsed.data.deviceName ?? row.device_name,
        metadata?.platform ?? row.platform,
        metadata === undefined
          ? row.app_version
          : (metadata.appVersion ?? null),
        metadata === undefined
          ? row.runtime_version
          : (metadata.runtimeVersion ?? null),
        nowMs,
        owner,
        id,
      );

    if (result.changes === 0) {
      const current = this.#findForOwner(owner, id);
      if (!current) return null;
      if (nowMs < current.updated_at_ms) {
        throw new DeviceRepositoryError(
          "INVALID_CLOCK",
          "Clock không được đi lùi so với updatedAt hiện tại.",
        );
      }
      throw new Error("Device update không thể hoàn tất.");
    }
    const updated = this.#findForOwner(owner, id);
    if (!updated) throw new Error("Device update không thể đọc lại.");
    return snapshot(updated);
  }

  async isOwnedBy(ownerId: string, deviceId: string): Promise<boolean> {
    return (
      this.#findForOwner(parseOwnerId(ownerId), parseDeviceId(deviceId)) !==
      null
    );
  }

  #findById(deviceId: string): DeviceRow | null {
    return this.#database
      .query("SELECT * FROM devices WHERE device_id = ?1")
      .get(deviceId) as DeviceRow | null;
  }

  #findForOwner(ownerId: string, deviceId: string): DeviceRow | null {
    return this.#database
      .query("SELECT * FROM devices WHERE owner_id = ?1 AND device_id = ?2")
      .get(ownerId, deviceId) as DeviceRow | null;
  }

  #readNow(): number {
    const timestamp = this.#now().getTime();
    if (!Number.isFinite(timestamp)) {
      throw new DeviceRepositoryError(
        "INVALID_CLOCK",
        "Clock trả về thời điểm không hợp lệ.",
      );
    }
    return timestamp;
  }
}
