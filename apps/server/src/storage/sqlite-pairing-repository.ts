import type { Database } from "bun:sqlite";
import {
  claimPairingInputSchema,
  type ClaimPairingInput,
  type Device,
  type PairingSession,
  pairingSessionIdSchema,
  pairingSessionSchema,
} from "@doctmcp/schemas";
import {
  DEFAULT_PAIRING_CLAIMED_RETENTION_MS,
  DEFAULT_PAIRING_REPOSITORY_MAX_SESSIONS,
  type ClaimPairingRecordInput,
  type CreatePairingRecordInput,
  type InMemoryPairingSessionRepositoryOptions,
  PairingRepositoryError,
  type PairingRepositoryErrorCode,
  type PairingSessionRepository,
} from "../pairing";
import { SqliteDeviceRepository } from "./sqlite-device-repository";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

interface PairingRow {
  pairing_session_id: string;
  code_digest: string;
  created_at_ms: number;
  expires_at_ms: number;
  local_correlation_id: string | null;
  state: "pending" | "claimed" | "expired" | "cancelled";
  claimed_at_ms: number | null;
  device_id: string | null;
}

function fail(code: PairingRepositoryErrorCode, message: string): never {
  throw new PairingRepositoryError(code, message);
}

function sessionId(input: string): string {
  const parsed = pairingSessionIdSchema.safeParse(input);
  if (!parsed.success) return fail("INVALID_PAIRING_RECORD", "pairingSessionId không hợp lệ.");
  return parsed.data;
}

function digest(input: string): string {
  if (!DIGEST_PATTERN.test(input)) {
    return fail("INVALID_PAIRING_RECORD", "Pairing code digest không hợp lệ.");
  }
  return input;
}

function readTime(value: Date, label: string): number {
  const ms = value.getTime();
  if (!Number.isFinite(ms)) return fail("INVALID_CLOCK", `${label} không hợp lệ.`);
  return ms;
}

function snapshot(row: PairingRow): PairingSession {
  const parsed = pairingSessionSchema.safeParse({
    pairingSessionId: row.pairing_session_id,
    state: row.state,
    createdAt: new Date(row.created_at_ms),
    expiresAt: new Date(row.expires_at_ms),
    ...(row.local_correlation_id === null ? {} : {
      localCorrelationId: row.local_correlation_id,
    }),
    ...(row.claimed_at_ms === null ? {} : { claimedAt: new Date(row.claimed_at_ms) }),
    ...(row.device_id === null ? {} : { deviceId: row.device_id }),
  });
  if (!parsed.success) return fail("INVALID_PAIRING_RECORD", "Pairing row vi phạm domain invariant.");
  return Object.freeze(parsed.data);
}

const PRUNE_CONDITION = `(
  (state = 'claimed' AND claimed_at_ms + ?1 <= ?2)
  OR (state <> 'claimed' AND expires_at_ms <= ?2)
)`;

/**
 * SQLite pairing and device repository MUST share the same connection.
 * Claim's synchronous insert and UPDATE run inside one BEGIN IMMEDIATE
 * transaction; exceptions after INSERT roll back both mutations.
 */
export class SqlitePairingSessionRepository implements PairingSessionRepository {
  readonly #database: Database;
  readonly #devices: SqliteDeviceRepository;
  readonly #now: () => Date;
  readonly #maxSessions: number;
  readonly #claimedRetentionMs: number;

  constructor(
    database: Database,
    devices: SqliteDeviceRepository,
    options: InMemoryPairingSessionRepositoryOptions = {},
  ) {
    this.#database = database;
    this.#devices = devices;
    this.#now = options.now ?? (() => new Date());
    this.#maxSessions = options.maxSessions ?? DEFAULT_PAIRING_REPOSITORY_MAX_SESSIONS;
    this.#claimedRetentionMs = options.claimedRetentionMs ?? DEFAULT_PAIRING_CLAIMED_RETENTION_MS;
    if (!Number.isSafeInteger(this.#maxSessions) || this.#maxSessions <= 0 ||
      !Number.isSafeInteger(this.#claimedRetentionMs) || this.#claimedRetentionMs <= 0) {
      throw new Error("Pairing repository limits must be positive safe integers.");
    }
  }

  #byId(id: string): PairingRow | null {
    return this.#database.query(
      "SELECT * FROM pairing_sessions WHERE pairing_session_id = ?1",
    ).get(id) as PairingRow | null;
  }

  #byDigest(codeDigest: string): PairingRow | null {
    return this.#database.query(
      "SELECT * FROM pairing_sessions WHERE code_digest = ?1",
    ).get(codeDigest) as PairingRow | null;
  }

  #prune(atMs: number): number {
    this.#database.query(
      `INSERT OR IGNORE INTO pairing_code_tombstones (code_digest)
       SELECT code_digest FROM pairing_sessions WHERE ${PRUNE_CONDITION}`,
    ).run(this.#claimedRetentionMs, atMs);
    const deleted = this.#database.query(
      `DELETE FROM pairing_sessions WHERE ${PRUNE_CONDITION}`,
    ).run(this.#claimedRetentionMs, atMs);
    return deleted.changes;
  }

  async create(input: CreatePairingRecordInput): Promise<PairingSession> {
    const id = sessionId(input.pairingSessionId);
    const codeDigest = digest(input.codeDigest);
    const createdAtMs = readTime(input.createdAt, "createdAt");
    const expiresAtMs = readTime(input.expiresAt, "expiresAt");
    if (expiresAtMs <= createdAtMs) {
      return fail("INVALID_PAIRING_RECORD", "expiresAt phải sau createdAt.");
    }
    const candidate = pairingSessionSchema.safeParse({
      pairingSessionId: id,
      state: "pending",
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      ...(input.localCorrelationId === undefined ? {} : {
        localCorrelationId: input.localCorrelationId,
      }),
    });
    if (!candidate.success) return fail("INVALID_PAIRING_RECORD", "Pairing input không hợp lệ.");

    return this.#database.transaction(() => {
      this.#prune(createdAtMs);
      if (this.#byId(id)) return fail(
        "PAIRING_SESSION_ALREADY_EXISTS", "pairingSessionId đã tồn tại.",
      );
      if (this.#byDigest(codeDigest) || this.#database.query(
        "SELECT 1 FROM pairing_code_tombstones WHERE code_digest = ?1",
      ).get(codeDigest)) {
        return fail("PAIRING_CODE_DIGEST_ALREADY_EXISTS", "Pairing code digest đã tồn tại.");
      }
      const count = this.#database.query(
        "SELECT COUNT(*) AS total FROM pairing_sessions",
      ).get() as { total: number };
      if (count.total >= this.#maxSessions) {
        return fail("PAIRING_CAPACITY_EXCEEDED", "Pairing repository capacity is full.");
      }
      this.#database.query(`INSERT INTO pairing_sessions
        (pairing_session_id, code_digest, created_at_ms, expires_at_ms,
         local_correlation_id, state, claimed_at_ms, device_id)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', NULL, NULL)`)
        .run(id, codeDigest, createdAtMs, expiresAtMs, input.localCorrelationId ?? null);
      const row = this.#byId(id);
      if (!row) throw new Error("Pairing create không thể đọc lại.");
      return snapshot(row);
    }).immediate();
  }

  async getById(pairingSessionId: string): Promise<PairingSession | null> {
    const row = this.#byId(sessionId(pairingSessionId));
    return row ? snapshot(row) : null;
  }

  async claim(input: ClaimPairingRecordInput): Promise<{ readonly session: PairingSession; readonly device: Device }> {
    const codeDigest = digest(input.codeDigest);
    // The clock is read AFTER acquiring the transaction lock, not during admission.
    const result = this.#database.transaction(() => {
      const claimedAtMs = readTime(this.#now(), "claimedAt");
      const row = this.#byDigest(codeDigest);
      if (!row || row.state !== "pending") return null;
      if (claimedAtMs >= row.expires_at_ms) {
        this.#database.query(
          "UPDATE pairing_sessions SET state = 'expired' WHERE pairing_session_id = ?1",
        ).run(row.pairing_session_id);
        return null;
      }
      if (claimedAtMs < row.created_at_ms) {
        return fail("INVALID_CLOCK", "claimedAt không được trước createdAt.");
      }
      const parsed = claimPairingInputSchema.safeParse({
        ownerId: input.ownerId,
        deviceName: input.deviceName,
        metadata: input.metadata,
      } satisfies ClaimPairingInput);
      if (!parsed.success) return fail("INVALID_PAIRING_RECORD", "Device claim input không hợp lệ.");
      // Intentionally synchronous: await here would commit before the device insert.
      const device = this.#devices.createInTransaction(this.#database, parsed.data);
      const changed = this.#database.query(`UPDATE pairing_sessions
        SET state = 'claimed', claimed_at_ms = ?1, device_id = ?2
        WHERE pairing_session_id = ?3 AND state = 'pending'`)
        .run(claimedAtMs, device.deviceId, row.pairing_session_id);
      if (changed.changes !== 1) throw new Error("Pairing claim lost its atomic boundary.");
      const claimed = this.#byId(row.pairing_session_id);
      if (!claimed) throw new Error("Claimed session không thể đọc lại.");
      return Object.freeze({ session: snapshot(claimed), device });
    }).immediate();
    if (!result) return fail("PAIRING_CODE_UNAVAILABLE", "Pairing code không khả dụng.");
    return result;
  }

  async cancel(pairingSessionId: string, cancelledAt: Date): Promise<PairingSession> {
    const id = sessionId(pairingSessionId);
    const nowMs = readTime(cancelledAt, "cancelledAt");
    const result = this.#database.transaction(() => {
      const row = this.#byId(id);
      if (!row) return fail("PAIRING_SESSION_NOT_FOUND", "Pairing session không tồn tại.");
      if (row.state === "pending" && nowMs >= row.expires_at_ms) {
        this.#database.query(
          "UPDATE pairing_sessions SET state = 'expired' WHERE pairing_session_id = ?1",
        ).run(id);
      } else {
        if (row.state !== "pending") return fail(
          "PAIRING_SESSION_NOT_PENDING", "Pairing session không còn pending.",
        );
        if (nowMs < row.created_at_ms) return fail(
          "INVALID_CLOCK", "cancelledAt không được trước createdAt.",
        );
        this.#database.query(
          "UPDATE pairing_sessions SET state = 'cancelled' WHERE pairing_session_id = ?1",
        ).run(id);
      }
      const updated = this.#byId(id);
      if (!updated) throw new Error("Pairing cancel không thể đọc lại.");
      return snapshot(updated);
    }).immediate();
    return result;
  }

  async expire(expiredAt: Date): Promise<number> {
    const nowMs = readTime(expiredAt, "expiredAt");
    return this.#database.transaction(() => this.#database.query(
      "UPDATE pairing_sessions SET state = 'expired' WHERE state = 'pending' AND expires_at_ms <= ?1",
    ).run(nowMs).changes).immediate();
  }

  async pruneExpired(expiredAt: Date): Promise<number> {
    const nowMs = readTime(expiredAt, "expiredAt");
    return this.#database.transaction(() => this.#prune(nowMs)).immediate();
  }
}
