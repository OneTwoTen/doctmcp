import type { Database } from "bun:sqlite";
import {
  DEFAULT_PAIRING_COMPLETION_MAX_RECORDS,
  DEFAULT_PAIRING_COMPLETION_RETENTION_MS,
  type InMemoryPairingCredentialCompletionRepositoryOptions,
  type PairingCredentialCompletionRecord,
  type PairingCredentialCompletionRepository,
} from "../pairing-credential-completion";

interface CompletionRow {
  pairing_session_id: string;
  state: "reserved" | "pending" | "recovering" | "delivered";
  device_id: string | null;
  credential_id: string | null;
  credential_version: number | null;
  recovery_target_credential_id: string | null;
  expires_at_ms: number;
}

function snapshot(row: CompletionRow): PairingCredentialCompletionRecord | null {
  if (row.state === "reserved") return null;
  if (
    row.device_id === null ||
    row.credential_id === null ||
    row.credential_version === null
  ) {
    throw new Error("Pairing completion row không hợp lệ.");
  }
  return Object.freeze({
    pairingSessionId: row.pairing_session_id,
    state: row.state,
    deviceId: row.device_id,
    credentialId: row.credential_id,
    credentialVersion: row.credential_version,
    ...(row.recovery_target_credential_id === null
      ? {}
      : { recoveryTargetCredentialId: row.recovery_target_credential_id }),
  });
}

/** Durable reservation/recovery metadata, never a credential raw secret. */
export class SqlitePairingCredentialCompletionRepository
  implements PairingCredentialCompletionRepository
{
  readonly #database: Database;
  readonly #now: () => Date;
  readonly #maxRecords: number;
  readonly #retentionMs: number;

  constructor(
    database: Database,
    options: InMemoryPairingCredentialCompletionRepositoryOptions = {},
  ) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#maxRecords = options.maxRecords ?? DEFAULT_PAIRING_COMPLETION_MAX_RECORDS;
    this.#retentionMs = options.retentionMs ?? DEFAULT_PAIRING_COMPLETION_RETENTION_MS;
    if (!Number.isSafeInteger(this.#maxRecords) || this.#maxRecords <= 0 ||
      !Number.isSafeInteger(this.#retentionMs) || this.#retentionMs <= 0) {
      throw new Error("Pairing completion limits must be positive safe integers.");
    }
  }

  #nowMs(): number {
    const ms = this.#now().getTime();
    if (!Number.isFinite(ms)) throw new Error("Pairing completion clock không hợp lệ.");
    return ms;
  }

  #row(id: string): CompletionRow | null {
    return this.#database.query(
      "SELECT * FROM pairing_credential_completions WHERE pairing_session_id = ?1",
    ).get(id) as CompletionRow | null;
  }

  #prune(nowMs: number): void {
    this.#database.query(
      "DELETE FROM pairing_credential_completions WHERE expires_at_ms <= ?1",
    ).run(nowMs);
  }

  #count(): number {
    const result = this.#database.query(
      "SELECT COUNT(*) AS total FROM pairing_credential_completions",
    ).get() as { total: number };
    return result.total;
  }

  #store(
    record: PairingCredentialCompletionRecord,
    nowMs: number,
  ): PairingCredentialCompletionRecord {
    this.#database.query(`INSERT INTO pairing_credential_completions
      (pairing_session_id, state, device_id, credential_id, credential_version,
       recovery_target_credential_id, expires_at_ms)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(pairing_session_id) DO UPDATE SET
        state = excluded.state,
        device_id = excluded.device_id,
        credential_id = excluded.credential_id,
        credential_version = excluded.credential_version,
        recovery_target_credential_id = excluded.recovery_target_credential_id,
        expires_at_ms = excluded.expires_at_ms`)
      .run(
        record.pairingSessionId,
        record.state,
        record.deviceId,
        record.credentialId,
        record.credentialVersion,
        record.recoveryTargetCredentialId ?? null,
        nowMs + this.#retentionMs,
      );
    const row = this.#row(record.pairingSessionId);
    if (!row) throw new Error("Pairing completion không thể đọc lại.");
    const stored = snapshot(row);
    if (!stored) throw new Error("Pairing completion không hợp lệ.");
    return stored;
  }

  #run<T>(action: (nowMs: number) => T): T {
    return this.#database.transaction(() => {
      const nowMs = this.#nowMs();
      this.#prune(nowMs);
      return action(nowMs);
    }).immediate();
  }

  async reserve(pairingSessionId: string): Promise<boolean> {
    return this.#run((nowMs) => {
      if (this.#row(pairingSessionId)) return true;
      if (this.#count() >= this.#maxRecords) return false;
      this.#database.query(`INSERT INTO pairing_credential_completions
        (pairing_session_id, state, device_id, credential_id,
         credential_version, recovery_target_credential_id, expires_at_ms)
        VALUES (?1, 'reserved', NULL, NULL, NULL, NULL, ?2)`)
        .run(pairingSessionId, nowMs + this.#retentionMs);
      return true;
    });
  }

  async transferReservation(
    fromPairingSessionId: string,
    toPairingSessionId: string,
  ): Promise<boolean> {
    return this.#run(() => {
      const source = this.#row(fromPairingSessionId);
      if (source?.state !== "reserved" || this.#row(toPairingSessionId)) return false;
      return this.#database.query(`UPDATE pairing_credential_completions
        SET pairing_session_id = ?1
        WHERE pairing_session_id = ?2 AND state = 'reserved'`)
        .run(toPairingSessionId, fromPairingSessionId).changes === 1;
    });
  }

  async get(pairingSessionId: string): Promise<PairingCredentialCompletionRecord | null> {
    return this.#run(() => {
      const row = this.#row(pairingSessionId);
      return row ? snapshot(row) : null;
    });
  }

  async setPending(
    input: Parameters<PairingCredentialCompletionRepository["setPending"]>[0],
  ): Promise<PairingCredentialCompletionRecord | null> {
    return this.#run((nowMs) => {
      const existing = this.#row(input.pairingSessionId);
      if (existing && existing.state !== "reserved") {
        return existing.state === "pending" && existing.device_id === input.deviceId &&
          existing.credential_id === input.credentialId &&
          existing.credential_version === input.credentialVersion
          ? snapshot(existing)
          : null;
      }
      if (!existing && this.#count() >= this.#maxRecords) return null;
      return this.#store({ ...input, state: "pending" }, nowMs);
    });
  }

  async beginRecovery(
    input: Parameters<PairingCredentialCompletionRepository["beginRecovery"]>[0],
  ): Promise<PairingCredentialCompletionRecord | null> {
    return this.#run((nowMs) => {
      const existing = this.#row(input.pairingSessionId);
      if (existing?.state === "delivered") return null;
      if (existing?.device_id !== null && existing?.device_id !== undefined &&
        existing.device_id !== input.deviceId) return null;
      if (existing?.state === "recovering") return snapshot(existing);
      if (!existing && this.#count() >= this.#maxRecords) return null;
      const source = existing?.state === "pending" ? existing : null;
      return this.#store({
        pairingSessionId: input.pairingSessionId,
        deviceId: input.deviceId,
        credentialId: source?.credential_id ?? input.credentialId,
        credentialVersion: source?.credential_version ?? input.credentialVersion,
        recoveryTargetCredentialId: input.recoveryTargetCredentialId,
        state: "recovering",
      }, nowMs);
    });
  }

  async advanceRecovery(
    input: Parameters<PairingCredentialCompletionRepository["advanceRecovery"]>[0],
  ): Promise<PairingCredentialCompletionRecord | null> {
    return this.#run((nowMs) => {
      const old = this.#row(input.pairingSessionId);
      if (old?.state !== "recovering" || old.device_id !== input.deviceId ||
        old.credential_id !== input.expectedCredentialId ||
        old.credential_version !== input.expectedCredentialVersion ||
        old.recovery_target_credential_id !== input.credentialId ||
        input.credentialVersion !== old.credential_version + 1) return null;
      return this.#store({
        pairingSessionId: input.pairingSessionId,
        deviceId: input.deviceId,
        credentialId: input.credentialId,
        credentialVersion: input.credentialVersion,
        recoveryTargetCredentialId: input.recoveryTargetCredentialId,
        state: "recovering",
      }, nowMs);
    });
  }

  async finishRecovery(
    input: Parameters<PairingCredentialCompletionRepository["finishRecovery"]>[0],
  ): Promise<PairingCredentialCompletionRecord | null> {
    return this.#run((nowMs) => {
      const old = this.#row(input.pairingSessionId);
      if (old?.state !== "recovering" || old.device_id !== input.deviceId ||
        old.credential_id !== input.expectedCredentialId ||
        old.credential_version !== input.expectedCredentialVersion ||
        old.recovery_target_credential_id !== input.credentialId ||
        input.credentialVersion !== old.credential_version + 1) return null;
      return this.#store({
        pairingSessionId: input.pairingSessionId,
        deviceId: input.deviceId,
        credentialId: input.credentialId,
        credentialVersion: input.credentialVersion,
        state: "pending",
      }, nowMs);
    });
  }

  async acknowledge(
    input: Parameters<PairingCredentialCompletionRepository["acknowledge"]>[0],
  ): Promise<PairingCredentialCompletionRecord | null> {
    return this.#run((nowMs) => {
      const old = this.#row(input.pairingSessionId);
      if (!old || old.device_id !== input.deviceId ||
        old.credential_id !== input.expectedCredentialId ||
        old.credential_version !== input.expectedCredentialVersion) return null;
      if (old.state === "delivered") return snapshot(old);
      if (old.state !== "pending") return null;
      return this.#store({
        pairingSessionId: input.pairingSessionId,
        deviceId: input.deviceId,
        credentialId: input.expectedCredentialId,
        credentialVersion: input.expectedCredentialVersion,
        state: "delivered",
      }, nowMs);
    });
  }

  async delete(pairingSessionId: string): Promise<void> {
    this.#run(() => {
      this.#database.query(
        "DELETE FROM pairing_credential_completions WHERE pairing_session_id = ?1",
      ).run(pairingSessionId);
    });
  }
}
