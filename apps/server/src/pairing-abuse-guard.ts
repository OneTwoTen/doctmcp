import type { PairingClaimAttempt, PairingClaimAttemptGuard } from "./pairing";

export const DEFAULT_PAIRING_ABUSE_WINDOW_MS = 60_000;
export const DEFAULT_PAIRING_STARTS_PER_ADDRESS = 10;
export const DEFAULT_PAIRING_CLAIMS_PER_OWNER = 10;
export const DEFAULT_PAIRING_ABUSE_MAX_BUCKETS = 10_000;

export type PairingAbuseGuardErrorCode = "PAIRING_RATE_LIMITED";

export interface PairingAbuseGuard extends PairingClaimAttemptGuard {
  beforeStart(remoteAddress?: string): void | Promise<void>;
}

export class PairingAbuseError extends Error {
  constructor(
    public readonly code: PairingAbuseGuardErrorCode = "PAIRING_RATE_LIMITED",
  ) {
    super("Pairing operation is temporarily unavailable.");
    this.name = "PairingAbuseError";
  }
}

export interface PairingAbuseGuardOptions {
  readonly now?: () => number;
  readonly windowMs?: number;
  readonly maxStartsPerAddress?: number;
  readonly maxClaimsPerOwner?: number;
  readonly maxBuckets?: number;
}

interface RateBucket {
  windowStartedAt: number;
  count: number;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

export class InMemoryPairingAbuseGuard implements PairingAbuseGuard {
  readonly #now: () => number;
  readonly #windowMs: number;
  readonly #maxStartsPerAddress: number;
  readonly #maxClaimsPerOwner: number;
  readonly #maxBuckets: number;
  readonly #buckets = new Map<string, RateBucket>();

  constructor(options: PairingAbuseGuardOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#windowMs = positiveSafeInteger(
      options.windowMs ?? DEFAULT_PAIRING_ABUSE_WINDOW_MS,
      "windowMs",
    );
    this.#maxStartsPerAddress = positiveSafeInteger(
      options.maxStartsPerAddress ?? DEFAULT_PAIRING_STARTS_PER_ADDRESS,
      "maxStartsPerAddress",
    );
    this.#maxClaimsPerOwner = positiveSafeInteger(
      options.maxClaimsPerOwner ?? DEFAULT_PAIRING_CLAIMS_PER_OWNER,
      "maxClaimsPerOwner",
    );
    this.#maxBuckets = positiveSafeInteger(
      options.maxBuckets ?? DEFAULT_PAIRING_ABUSE_MAX_BUCKETS,
      "maxBuckets",
    );
  }

  beforeStart(remoteAddress?: string): void {
    const key =
      remoteAddress && remoteAddress.length <= 128
        ? `start:${remoteAddress}`
        : "start:unknown";
    this.#consume(key, this.#maxStartsPerAddress);
  }

  beforeClaim(attempt: PairingClaimAttempt): void {
    // codeDigest is intentionally never used as a bucket key or retained.
    this.#consume(`claim:${attempt.ownerId}`, this.#maxClaimsPerOwner);
  }

  #consume(key: string, limit: number): void {
    const now = this.#now();
    if (!Number.isFinite(now)) throw new PairingAbuseError();
    this.#cleanup(now);

    let bucket = this.#buckets.get(key);
    if (!bucket) {
      if (this.#buckets.size >= this.#maxBuckets) throw new PairingAbuseError();
      bucket = { windowStartedAt: now, count: 0 };
      this.#buckets.set(key, bucket);
    } else if (now < bucket.windowStartedAt) {
      throw new PairingAbuseError();
    } else if (now - bucket.windowStartedAt >= this.#windowMs) {
      bucket.windowStartedAt = now;
      bucket.count = 0;
    }

    if (bucket.count >= limit) throw new PairingAbuseError();
    bucket.count += 1;
  }

  #cleanup(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (
        now >= bucket.windowStartedAt &&
        now - bucket.windowStartedAt >= this.#windowMs
      ) {
        this.#buckets.delete(key);
      }
    }
  }
}
