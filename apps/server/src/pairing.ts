import {
  type ClaimPairingInput,
  type CreatePairingSessionInput,
  claimPairingInputSchema,
  createPairingSessionInputSchema,
  type Device,
  type PairingSession,
  pairingSessionIdSchema,
  pairingSessionSchema,
} from "@doctmcp/schemas";
import type { DeviceRepository } from "./device-repository";

export const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_SYMBOLS = 12;
export const PAIRING_CODE_GROUP_SIZE = 4;
export const PAIRING_CODE_ENTROPY_BITS = 60;
export const PAIRING_CREATE_MAX_ATTEMPTS = 5;
export const DEFAULT_PAIRING_REPOSITORY_MAX_SESSIONS = 10_000;
export const DEFAULT_PAIRING_CLAIMED_RETENTION_MS = 10 * 60 * 1000;
export const DEFAULT_PAIRING_EXPIRED_CODE_TOMBSTONES = 100_000;

const PAIRING_CODE_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PAIRING_CODE_DIGEST_PREFIX = "doctmcp-pairing:v1:";

export type PairingClock = () => Date;
export type PairingCodeGenerator = () => string;
export type PairingSessionIdGenerator = () => string;

export interface PairingClaimContext {
  readonly remoteAddress?: string;
}

export interface PairingClaimAttempt {
  readonly ownerId: string;
  readonly codeDigest: string | null;
  readonly remoteAddress?: string;
}

/**
 * Hook cho rate limit / anti-bruteforce ở boundary HTTP/auth sau này.
 * Raw pairing code cố ý không được truyền vào hook để tránh log secret ngoài ý muốn.
 */
export interface PairingClaimAttemptGuard {
  beforeClaim(attempt: PairingClaimAttempt): Promise<void> | void;
}

export interface CreatePairingSessionResult {
  readonly pairingCode: string;
  readonly session: PairingSession;
}

export interface ClaimPairingResult {
  readonly session: PairingSession;
  readonly device: Device;
}

export type PairingServiceErrorCode =
  | "INVALID_PAIRING_INPUT"
  | "INVALID_PAIRING_CONFIGURATION"
  | "INVALID_CLOCK"
  | "PAIRING_CODE_UNAVAILABLE"
  | "PAIRING_SESSION_NOT_FOUND"
  | "PAIRING_SESSION_NOT_PENDING"
  | "PAIRING_CREATE_FAILED";

export class PairingServiceError extends Error {
  constructor(
    public readonly code: PairingServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PairingServiceError";
  }
}

export type PairingRepositoryErrorCode =
  | "PAIRING_SESSION_ALREADY_EXISTS"
  | "PAIRING_CODE_DIGEST_ALREADY_EXISTS"
  | "PAIRING_CODE_UNAVAILABLE"
  | "PAIRING_SESSION_NOT_FOUND"
  | "PAIRING_SESSION_NOT_PENDING"
  | "PAIRING_CAPACITY_EXCEEDED"
  | "INVALID_PAIRING_RECORD"
  | "INVALID_CLOCK";

export class PairingRepositoryError extends Error {
  constructor(
    public readonly code: PairingRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PairingRepositoryError";
  }
}

export interface CreatePairingRecordInput {
  readonly pairingSessionId: string;
  readonly codeDigest: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly localCorrelationId?: string;
}

export interface ClaimPairingRecordInput extends ClaimPairingInput {
  readonly codeDigest: string;
}

export interface PairingSessionRepository {
  create(input: CreatePairingRecordInput): Promise<PairingSession>;
  getById(pairingSessionId: string): Promise<PairingSession | null>;
  claim(input: ClaimPairingRecordInput): Promise<ClaimPairingResult>;
  cancel(pairingSessionId: string, cancelledAt: Date): Promise<PairingSession>;
  expire(expiredAt: Date): Promise<number>;
  pruneExpired(expiredAt: Date): Promise<number>;
}

export interface InMemoryPairingSessionRepositoryOptions {
  readonly now?: PairingClock;
  readonly maxSessions?: number;
  readonly claimedRetentionMs?: number;
}

interface StoredPairingSession {
  readonly pairingSessionId: string;
  readonly codeDigest: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly localCorrelationId?: string;
  state: "pending" | "claimed" | "expired" | "cancelled";
  claimedAtMs?: number;
  deviceId?: string;
}

function repositoryError(
  code: PairingRepositoryErrorCode,
  message: string,
): never {
  throw new PairingRepositoryError(code, message);
}

function parsePairingSessionId(pairingSessionId: string): string {
  const result = pairingSessionIdSchema.safeParse(pairingSessionId);
  if (!result.success) {
    return repositoryError(
      "INVALID_PAIRING_RECORD",
      "pairingSessionId không hợp lệ.",
    );
  }
  return result.data;
}

function parseDigest(codeDigest: string): string {
  if (!PAIRING_CODE_DIGEST_PATTERN.test(codeDigest)) {
    return repositoryError(
      "INVALID_PAIRING_RECORD",
      "Pairing code digest không hợp lệ.",
    );
  }
  return codeDigest;
}

function readTimestamp(value: Date, label: string): number {
  const timestamp = value.getTime();
  if (!Number.isFinite(timestamp)) {
    return repositoryError("INVALID_CLOCK", `${label} không hợp lệ.`);
  }
  return timestamp;
}

function toSessionSnapshot(record: StoredPairingSession): PairingSession {
  const candidate = {
    pairingSessionId: record.pairingSessionId,
    state: record.state,
    createdAt: new Date(record.createdAtMs),
    expiresAt: new Date(record.expiresAtMs),
    ...(record.localCorrelationId !== undefined
      ? { localCorrelationId: record.localCorrelationId }
      : {}),
    ...(record.claimedAtMs !== undefined && record.deviceId !== undefined
      ? {
          claimedAt: new Date(record.claimedAtMs),
          deviceId: record.deviceId,
        }
      : {}),
  };

  const parsed = pairingSessionSchema.safeParse(candidate);
  if (!parsed.success) {
    return repositoryError(
      "INVALID_PAIRING_RECORD",
      "Pairing record vi phạm domain invariant.",
    );
  }
  return Object.freeze(parsed.data);
}

/**
 * Adapter deterministic cho M3 integration/concurrency test.
 * Tất cả mutation dùng cùng một async critical section. Claim đọc authoritative clock
 * sau khi đã acquire boundary và Device creation cũng chạy bên trong boundary đó.
 * Production adapter phải thay boundary này bằng transaction/lock/CAS tương đương.
 */
export class InMemoryPairingSessionRepository
  implements PairingSessionRepository
{
  readonly #deviceRepository: DeviceRepository;
  readonly #now: PairingClock;
  readonly #maxSessions: number;
  readonly #claimedRetentionMs: number;
  readonly #expiredCodeTombstones = new Set<string>();
  readonly #expiredCodeTombstoneOrder: string[] = [];
  readonly #recordsById = new Map<string, StoredPairingSession>();
  readonly #sessionIdByDigest = new Map<string, string>();
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(
    deviceRepository: DeviceRepository,
    options: InMemoryPairingSessionRepositoryOptions = {},
  ) {
    this.#deviceRepository = deviceRepository;
    this.#now = options.now ?? (() => new Date());
    this.#maxSessions =
      options.maxSessions ?? DEFAULT_PAIRING_REPOSITORY_MAX_SESSIONS;
    this.#claimedRetentionMs =
      options.claimedRetentionMs ?? DEFAULT_PAIRING_CLAIMED_RETENTION_MS;
    if (!Number.isSafeInteger(this.#maxSessions) || this.#maxSessions <= 0) {
      throw new Error("maxSessions must be a positive safe integer.");
    }
    if (
      !Number.isSafeInteger(this.#claimedRetentionMs) ||
      this.#claimedRetentionMs <= 0
    ) {
      throw new Error("claimedRetentionMs must be a positive safe integer.");
    }
  }

  async create(input: CreatePairingRecordInput): Promise<PairingSession> {
    const pairingSessionId = parsePairingSessionId(input.pairingSessionId);
    const codeDigest = parseDigest(input.codeDigest);
    const createdAtMs = readTimestamp(input.createdAt, "createdAt");
    const expiresAtMs = readTimestamp(input.expiresAt, "expiresAt");

    if (expiresAtMs <= createdAtMs) {
      return repositoryError(
        "INVALID_PAIRING_RECORD",
        "expiresAt phải sau createdAt.",
      );
    }

    return this.#runExclusive(async () => {
      this.#pruneExpiredRecords(createdAtMs);
      if (this.#recordsById.has(pairingSessionId)) {
        return repositoryError(
          "PAIRING_SESSION_ALREADY_EXISTS",
          "pairingSessionId đã tồn tại.",
        );
      }
      if (
        this.#sessionIdByDigest.has(codeDigest) ||
        this.#expiredCodeTombstones.has(codeDigest)
      ) {
        return repositoryError(
          "PAIRING_CODE_DIGEST_ALREADY_EXISTS",
          "Pairing code digest đã tồn tại.",
        );
      }
      if (this.#recordsById.size >= this.#maxSessions) {
        return repositoryError(
          "PAIRING_CAPACITY_EXCEEDED",
          "Pairing repository capacity is full.",
        );
      }

      const record: StoredPairingSession = {
        pairingSessionId,
        codeDigest,
        createdAtMs,
        expiresAtMs,
        ...(input.localCorrelationId !== undefined
          ? { localCorrelationId: input.localCorrelationId }
          : {}),
        state: "pending",
      };

      const snapshot = toSessionSnapshot(record);
      this.#recordsById.set(pairingSessionId, record);
      this.#sessionIdByDigest.set(codeDigest, pairingSessionId);
      return snapshot;
    });
  }

  async getById(pairingSessionId: string): Promise<PairingSession | null> {
    const parsedId = parsePairingSessionId(pairingSessionId);
    const record = this.#recordsById.get(parsedId);
    return record ? toSessionSnapshot(record) : null;
  }

  async claim(input: ClaimPairingRecordInput): Promise<ClaimPairingResult> {
    const codeDigest = parseDigest(input.codeDigest);

    return this.#runExclusive(async () => {
      const claimedAtMs = readTimestamp(this.#now(), "claimedAt");
      const pairingSessionId = this.#sessionIdByDigest.get(codeDigest);
      const record = pairingSessionId
        ? this.#recordsById.get(pairingSessionId)
        : undefined;

      if (!record) {
        return repositoryError(
          "PAIRING_CODE_UNAVAILABLE",
          "Pairing code không khả dụng.",
        );
      }

      if (record.state === "pending" && claimedAtMs >= record.expiresAtMs) {
        record.state = "expired";
      }

      if (record.state !== "pending") {
        return repositoryError(
          "PAIRING_CODE_UNAVAILABLE",
          "Pairing code không khả dụng.",
        );
      }

      if (claimedAtMs < record.createdAtMs) {
        return repositoryError(
          "INVALID_CLOCK",
          "claimedAt không được trước createdAt.",
        );
      }

      const device = await this.#deviceRepository.create({
        ownerId: input.ownerId,
        deviceName: input.deviceName,
        metadata: input.metadata,
      });

      record.state = "claimed";
      record.claimedAtMs = claimedAtMs;
      record.deviceId = device.deviceId;

      return Object.freeze({
        session: toSessionSnapshot(record),
        device,
      });
    });
  }

  async cancel(
    pairingSessionId: string,
    cancelledAt: Date,
  ): Promise<PairingSession> {
    const parsedId = parsePairingSessionId(pairingSessionId);
    const cancelledAtMs = readTimestamp(cancelledAt, "cancelledAt");

    return this.#runExclusive(async () => {
      const record = this.#recordsById.get(parsedId);
      if (!record) {
        return repositoryError(
          "PAIRING_SESSION_NOT_FOUND",
          "Pairing session không tồn tại.",
        );
      }

      if (record.state === "pending" && cancelledAtMs >= record.expiresAtMs) {
        record.state = "expired";
        return toSessionSnapshot(record);
      }

      if (record.state !== "pending") {
        return repositoryError(
          "PAIRING_SESSION_NOT_PENDING",
          "Pairing session không còn pending.",
        );
      }

      if (cancelledAtMs < record.createdAtMs) {
        return repositoryError(
          "INVALID_CLOCK",
          "cancelledAt không được trước createdAt.",
        );
      }

      record.state = "cancelled";
      return toSessionSnapshot(record);
    });
  }

  async expire(expiredAt: Date): Promise<number> {
    const expiredAtMs = readTimestamp(expiredAt, "expiredAt");

    return this.#runExclusive(async () => {
      let count = 0;
      for (const record of this.#recordsById.values()) {
        if (record.state === "pending" && expiredAtMs >= record.expiresAtMs) {
          record.state = "expired";
          count += 1;
        }
      }
      return count;
    });
  }

  async pruneExpired(expiredAt: Date): Promise<number> {
    const expiredAtMs = readTimestamp(expiredAt, "expiredAt");
    return this.#runExclusive(async () =>
      this.#pruneExpiredRecords(expiredAtMs),
    );
  }

  #pruneExpiredRecords(expiredAtMs: number): number {
    let count = 0;
    for (const [pairingSessionId, record] of this.#recordsById) {
      const pruneAtMs =
        record.state === "claimed" && record.claimedAtMs !== undefined
          ? record.claimedAtMs + this.#claimedRetentionMs
          : record.expiresAtMs;
      if (pruneAtMs > expiredAtMs) continue;
      this.#recordsById.delete(pairingSessionId);
      this.#sessionIdByDigest.delete(record.codeDigest);
      this.#expiredCodeTombstones.add(record.codeDigest);
      this.#expiredCodeTombstoneOrder.push(record.codeDigest);
      while (
        this.#expiredCodeTombstoneOrder.length >
        DEFAULT_PAIRING_EXPIRED_CODE_TOMBSTONES
      ) {
        const oldest = this.#expiredCodeTombstoneOrder.shift();
        if (oldest !== undefined) this.#expiredCodeTombstones.delete(oldest);
      }
      count += 1;
    }
    return count;
  }

  async #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTail;
    let release: () => void = () => undefined;
    this.#mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export interface PairingServiceOptions {
  readonly repository: PairingSessionRepository;
  readonly ttlMs?: number;
  readonly now?: PairingClock;
  readonly generatePairingCode?: PairingCodeGenerator;
  readonly generatePairingSessionId?: PairingSessionIdGenerator;
  readonly claimAttemptGuard?: PairingClaimAttemptGuard;
}

const ALLOW_ALL_CLAIM_ATTEMPTS: PairingClaimAttemptGuard = {
  beforeClaim: () => undefined,
};

export class PairingService {
  readonly #repository: PairingSessionRepository;
  readonly #ttlMs: number;
  readonly #now: PairingClock;
  readonly #generatePairingCode: PairingCodeGenerator;
  readonly #generatePairingSessionId: PairingSessionIdGenerator;
  readonly #claimAttemptGuard: PairingClaimAttemptGuard;

  constructor(options: PairingServiceOptions) {
    if (!Number.isSafeInteger(options.ttlMs ?? DEFAULT_PAIRING_TTL_MS)) {
      throw new PairingServiceError(
        "INVALID_PAIRING_CONFIGURATION",
        "Pairing TTL phải là số nguyên an toàn.",
      );
    }

    this.#ttlMs = options.ttlMs ?? DEFAULT_PAIRING_TTL_MS;
    if (this.#ttlMs <= 0) {
      throw new PairingServiceError(
        "INVALID_PAIRING_CONFIGURATION",
        "Pairing TTL phải lớn hơn 0.",
      );
    }

    this.#repository = options.repository;
    this.#now = options.now ?? (() => new Date());
    this.#generatePairingCode =
      options.generatePairingCode ?? generateSecurePairingCode;
    this.#generatePairingSessionId =
      options.generatePairingSessionId ??
      (() => globalThis.crypto.randomUUID());
    this.#claimAttemptGuard =
      options.claimAttemptGuard ?? ALLOW_ALL_CLAIM_ATTEMPTS;
  }

  async createPairingSession(
    input: CreatePairingSessionInput = {},
  ): Promise<CreatePairingSessionResult> {
    const parsedInput = createPairingSessionInputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new PairingServiceError(
        "INVALID_PAIRING_INPUT",
        "Pairing session input không hợp lệ.",
      );
    }

    const createdAt = this.#readNow();
    const expiresAt = new Date(createdAt.getTime() + this.#ttlMs);

    for (let attempt = 0; attempt < PAIRING_CREATE_MAX_ATTEMPTS; attempt += 1) {
      const generatedCode = this.#generatePairingCode();
      const normalizedCode = normalizePairingCode(generatedCode);
      const parsedSessionId = pairingSessionIdSchema.safeParse(
        this.#generatePairingSessionId(),
      );

      if (normalizedCode === null || !parsedSessionId.success) {
        throw new PairingServiceError(
          "PAIRING_CREATE_FAILED",
          "Pairing generator trả về giá trị không hợp lệ.",
        );
      }

      const codeDigest = await digestPairingCode(normalizedCode);

      try {
        const session = await this.#repository.create({
          pairingSessionId: parsedSessionId.data,
          codeDigest,
          createdAt,
          expiresAt,
          ...(parsedInput.data.localCorrelationId !== undefined
            ? { localCorrelationId: parsedInput.data.localCorrelationId }
            : {}),
        });

        return Object.freeze({
          pairingCode: formatPairingCode(normalizedCode),
          session,
        });
      } catch (error) {
        if (
          error instanceof PairingRepositoryError &&
          (error.code === "PAIRING_SESSION_ALREADY_EXISTS" ||
            error.code === "PAIRING_CODE_DIGEST_ALREADY_EXISTS")
        ) {
          continue;
        }
        throw this.#mapRepositoryError(error);
      }
    }

    throw new PairingServiceError(
      "PAIRING_CREATE_FAILED",
      "Không thể cấp pairing session duy nhất.",
    );
  }

  async claimPairingCode(
    pairingCode: unknown,
    input: ClaimPairingInput,
    context: PairingClaimContext = {},
  ): Promise<ClaimPairingResult> {
    const parsedInput = claimPairingInputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new PairingServiceError(
        "INVALID_PAIRING_INPUT",
        "Pairing claim input không hợp lệ.",
      );
    }

    const normalizedCode = normalizePairingCode(pairingCode);
    if (normalizedCode === null) {
      await this.#claimAttemptGuard.beforeClaim({
        ownerId: parsedInput.data.ownerId,
        codeDigest: null,
        ...(context.remoteAddress !== undefined
          ? { remoteAddress: context.remoteAddress }
          : {}),
      });
      throw new PairingServiceError(
        "PAIRING_CODE_UNAVAILABLE",
        "Pairing code không khả dụng.",
      );
    }

    const codeDigest = await digestPairingCode(normalizedCode);
    await this.#claimAttemptGuard.beforeClaim({
      ownerId: parsedInput.data.ownerId,
      codeDigest,
      ...(context.remoteAddress !== undefined
        ? { remoteAddress: context.remoteAddress }
        : {}),
    });

    try {
      return await this.#repository.claim({
        codeDigest,
        ownerId: parsedInput.data.ownerId,
        deviceName: parsedInput.data.deviceName,
        metadata: parsedInput.data.metadata,
      });
    } catch (error) {
      throw this.#mapRepositoryError(error);
    }
  }

  async getPairingSession(
    pairingSessionId: string,
  ): Promise<PairingSession | null> {
    const parsedId = pairingSessionIdSchema.safeParse(pairingSessionId);
    if (!parsedId.success) {
      throw new PairingServiceError(
        "INVALID_PAIRING_INPUT",
        "pairingSessionId không hợp lệ.",
      );
    }

    try {
      return await this.#repository.getById(parsedId.data);
    } catch (error) {
      throw this.#mapRepositoryError(error);
    }
  }

  async cancelPairingSession(
    pairingSessionId: string,
  ): Promise<PairingSession> {
    const parsedId = pairingSessionIdSchema.safeParse(pairingSessionId);
    if (!parsedId.success) {
      throw new PairingServiceError(
        "INVALID_PAIRING_INPUT",
        "pairingSessionId không hợp lệ.",
      );
    }

    try {
      return await this.#repository.cancel(parsedId.data, this.#readNow());
    } catch (error) {
      throw this.#mapRepositoryError(error);
    }
  }

  async expirePairingSessions(): Promise<number> {
    try {
      return await this.#repository.expire(this.#readNow());
    } catch (error) {
      throw this.#mapRepositoryError(error);
    }
  }

  async pruneExpiredPairingSessions(): Promise<number> {
    try {
      return await this.#repository.pruneExpired(this.#readNow());
    } catch (error) {
      throw this.#mapRepositoryError(error);
    }
  }

  #readNow(): Date {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) {
      throw new PairingServiceError(
        "INVALID_CLOCK",
        "Server clock trả về thời điểm không hợp lệ.",
      );
    }
    return new Date(now.getTime());
  }

  #mapRepositoryError(error: unknown): Error {
    if (!(error instanceof PairingRepositoryError)) {
      return error instanceof Error
        ? error
        : new PairingServiceError(
            "PAIRING_CREATE_FAILED",
            "Pairing operation thất bại.",
          );
    }

    switch (error.code) {
      case "PAIRING_CODE_UNAVAILABLE":
        return new PairingServiceError(
          "PAIRING_CODE_UNAVAILABLE",
          "Pairing code không khả dụng.",
        );
      case "PAIRING_SESSION_NOT_FOUND":
        return new PairingServiceError(
          "PAIRING_SESSION_NOT_FOUND",
          "Pairing session không tồn tại.",
        );
      case "PAIRING_SESSION_NOT_PENDING":
        return new PairingServiceError(
          "PAIRING_SESSION_NOT_PENDING",
          "Pairing session không còn pending.",
        );
      case "INVALID_CLOCK":
        return new PairingServiceError(
          "INVALID_CLOCK",
          "Server clock không hợp lệ cho pairing operation.",
        );
      default:
        return new PairingServiceError(
          "PAIRING_CREATE_FAILED",
          "Pairing operation thất bại.",
        );
    }
  }
}

/**
 * 12 ký tự trên alphabet 32 symbol = 60 bit entropy. Dùng CSPRNG và không có
 * modulo bias vì alphabet có đúng 2^5 symbol.
 */
export function generateSecurePairingCode(): string {
  const bytes = new Uint8Array(PAIRING_CODE_SYMBOLS);
  globalThis.crypto.getRandomValues(bytes);

  let compact = "";
  for (const byte of bytes) {
    compact += PAIRING_CODE_ALPHABET.charAt(byte & 31);
  }
  return formatPairingCode(compact);
}

/** Canonical lookup form: uppercase, bỏ whitespace/dash, giữ đúng 12 symbol. */
export function normalizePairingCode(pairingCode: unknown): string | null {
  if (typeof pairingCode !== "string") {
    return null;
  }

  const compact = pairingCode.toUpperCase().replace(/[\s-]/g, "");
  if (compact.length !== PAIRING_CODE_SYMBOLS) {
    return null;
  }

  for (const symbol of compact) {
    if (!PAIRING_CODE_ALPHABET.includes(symbol)) {
      return null;
    }
  }
  return compact;
}

export function formatPairingCode(normalizedCode: string): string {
  const groups: string[] = [];
  for (
    let offset = 0;
    offset < normalizedCode.length;
    offset += PAIRING_CODE_GROUP_SIZE
  ) {
    groups.push(normalizedCode.slice(offset, offset + PAIRING_CODE_GROUP_SIZE));
  }
  return groups.join("-");
}

export async function digestPairingCode(
  normalizedCode: string,
): Promise<string> {
  const input = new TextEncoder().encode(
    `${PAIRING_CODE_DIGEST_PREFIX}${normalizedCode}`,
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
