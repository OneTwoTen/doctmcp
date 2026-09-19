import { describe, expect, test } from "bun:test";
import {
  InMemoryPairingAbuseGuard,
  PairingAbuseError,
} from "./pairing-abuse-guard";

describe("InMemoryPairingAbuseGuard", () => {
  test("limits pairing starts by the server-observed remote address", () => {
    const guard = new InMemoryPairingAbuseGuard({
      now: () => 1_000,
      windowMs: 10_000,
      maxStartsPerAddress: 2,
    });

    guard.beforeStart("192.0.2.10");
    guard.beforeStart("192.0.2.10");
    expect(() => guard.beforeStart("192.0.2.10")).toThrow(PairingAbuseError);
    expect(() => guard.beforeStart("192.0.2.11")).not.toThrow();
  });

  test("limits claims by authenticated owner without retaining the code digest", () => {
    const rawCode = "ABCD-EFGH-JKLM";
    const guard = new InMemoryPairingAbuseGuard({
      now: () => 1_000,
      windowMs: 10_000,
      maxClaimsPerOwner: 1,
    });

    guard.beforeClaim({ ownerId: "owner-a", codeDigest: "a".repeat(64) });
    let failure: unknown;
    try {
      guard.beforeClaim({ ownerId: "owner-a", codeDigest: "b".repeat(64) });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(PairingAbuseError);
    expect((failure as Error).message).not.toContain(rawCode);
    expect(() =>
      guard.beforeClaim({ ownerId: "owner-b", codeDigest: null }),
    ).not.toThrow();
  });

  test("resets expired windows and denies safely when the clock is invalid", () => {
    let now = 1_000;
    const guard = new InMemoryPairingAbuseGuard({
      now: () => now,
      windowMs: 10_000,
      maxClaimsPerOwner: 1,
    });

    guard.beforeClaim({ ownerId: "owner-a", codeDigest: null });
    expect(() =>
      guard.beforeClaim({ ownerId: "owner-a", codeDigest: null }),
    ).toThrow(PairingAbuseError);
    now += 10_000;
    expect(() =>
      guard.beforeClaim({ ownerId: "owner-a", codeDigest: null }),
    ).not.toThrow();

    const invalidClock = new InMemoryPairingAbuseGuard({
      now: () => Number.NaN,
    });
    expect(() => invalidClock.beforeStart("192.0.2.10")).toThrow(
      PairingAbuseError,
    );
  });

  test("bounds the number of rate-limit buckets", () => {
    const guard = new InMemoryPairingAbuseGuard({
      now: () => 1_000,
      maxBuckets: 1,
      maxStartsPerAddress: 5,
    });

    guard.beforeStart("192.0.2.10");
    expect(() => guard.beforeStart("192.0.2.11")).toThrow(PairingAbuseError);
  });
});
