import { describe, expect, test } from "bun:test";
import type { DeviceCredentialRepository } from "./device-credential";
import type { DeviceRepository } from "./device-repository";
import type { PairingSessionRepository } from "./pairing";

const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREDENTIAL_A = "11111111-1111-4111-8111-111111111111";
const CREDENTIAL_B = "22222222-2222-4222-8222-222222222222";
const CREDENTIAL_C = "33333333-3333-4333-8333-333333333333";
const SESSION_A = "44444444-4444-4444-8444-444444444444";
const SESSION_B = "55555555-5555-4555-8555-555555555555";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const CREATED_AT_MS = Date.parse("2026-09-19T04:00:00.000Z");
const METADATA = Object.freeze({ platform: "darwin-arm64" });

export interface PersistentRepositoryContractHarness {
  readonly devices: DeviceRepository;
  readonly credentials: DeviceCredentialRepository;
  readonly pairings: PairingSessionRepository;
  readonly close?: () => Promise<void> | void;
}

export interface PersistentRepositoryContractOptions {
  readonly now: () => Date;
  readonly generateDeviceId: () => string;
}

/**
 * Tạo một bộ repositories độc lập cho mỗi test. SQLite adapter phải dùng cùng
 * database/transaction boundary cho devices và pairings, không trộn in-memory.
 */
export type PersistentRepositoryContractFactory = (
  options: PersistentRepositoryContractOptions,
) =>
  | Promise<PersistentRepositoryContractHarness>
  | PersistentRepositoryContractHarness;

async function withHarness(
  factory: PersistentRepositoryContractFactory,
  run: (
    harness: PersistentRepositoryContractHarness,
    setNow: (timestamp: number) => void,
  ) => Promise<void>,
  generateDeviceId: () => string = () => DEVICE_A,
): Promise<void> {
  let nowMs = CREATED_AT_MS;
  const harness = await factory({
    now: () => new Date(nowMs),
    generateDeviceId,
  });
  try {
    await run(harness, (timestamp) => {
      nowMs = timestamp;
    });
  } finally {
    await harness.close?.();
  }
}

function newDevice(ownerId: string) {
  return {
    ownerId,
    deviceName: "Contract device",
    metadata: METADATA,
  };
}

function newPairing(pairingSessionId: string, codeDigest: string) {
  return {
    pairingSessionId,
    codeDigest,
    createdAt: new Date(CREATED_AT_MS),
    expiresAt: new Date(CREATED_AT_MS + 60_000),
  };
}

function claim(ownerId: string, codeDigest: string) {
  return {
    ...newDevice(ownerId),
    codeDigest,
  };
}

/**
 * Chạy cùng một tập contract test cho InMemory và SQLite adapter.
 * Không assert implementation detail, file path hay SQLite SQL trong suite này.
 */
export function describePersistentRepositoryContract(
  adapterName: string,
  factory: PersistentRepositoryContractFactory,
): void {
  describe(`${adapterName} persistent repository contract`, () => {
    test("device snapshot, immutable identity và owner isolation", async () => {
      let nextId = DEVICE_A;
      await withHarness(
        factory,
        async ({ devices }) => {
          const created = await devices.create(newDevice("owner-a"));
          nextId = DEVICE_B;
          await devices.create(newDevice("owner-b"));

          expect(created.deviceId).toBe(DEVICE_A);
          expect(await devices.getForOwner("owner-b", DEVICE_A)).toBeNull();
          expect(await devices.isOwnedBy("owner-b", DEVICE_A)).toBe(false);
          expect(
            (await devices.listByOwnerId("owner-a")).map(
              (device) => device.deviceId,
            ),
          ).toEqual([DEVICE_A]);
          expect(
            await devices.updateForOwner("owner-b", DEVICE_A, {
              deviceName: "Forbidden",
            }),
          ).toBeNull();

          const updated = await devices.updateForOwner("owner-a", DEVICE_A, {
            deviceName: "Renamed",
          });
          expect(updated?.deviceId).toBe(DEVICE_A);
          expect(updated?.ownerId).toBe("owner-a");
          expect(updated?.deviceName).toBe("Renamed");
          expect((await devices.getById(DEVICE_A))?.deviceName).toBe("Renamed");
        },
        () => nextId,
      );
    });

    test("duplicate device identity không overwrite record cũ", async () => {
      await withHarness(factory, async ({ devices }) => {
        await devices.create(newDevice("owner-a"));
        await expect(
          devices.create(newDevice("owner-b")),
        ).rejects.toMatchObject({
          code: "DEVICE_ALREADY_EXISTS",
        });
        expect((await devices.getById(DEVICE_A))?.ownerId).toBe("owner-a");
      });
    });

    test("credential lưu digest, verify không trả secret, revoke chặn auth", async () => {
      await withHarness(factory, async ({ devices, credentials }) => {
        await devices.create(newDevice("owner-a"));
        const issued = await credentials.issue({
          deviceId: DEVICE_A,
          credentialId: CREDENTIAL_A,
          secretDigest: DIGEST_A,
          createdAt: new Date(CREATED_AT_MS),
        });
        expect(issued.version).toBe(1);
        expect(JSON.stringify(issued)).not.toContain(DIGEST_A);
        expect(await credentials.verify(DEVICE_A, DIGEST_B)).toBeNull();
        expect(
          (await credentials.verify(DEVICE_A, DIGEST_A))?.credentialId,
        ).toBe(CREDENTIAL_A);

        const revoked = await credentials.revoke({
          deviceId: DEVICE_A,
          expectedCredentialId: CREDENTIAL_A,
          expectedVersion: 1,
          revokedAt: new Date(CREATED_AT_MS + 1000),
        });
        expect(revoked?.state).toBe("revoked");
        expect(await credentials.verify(DEVICE_A, DIGEST_A)).toBeNull();
      });
    });

    test("credential rotate dùng generation CAS, old digest không còn hiệu lực", async () => {
      await withHarness(factory, async ({ devices, credentials }) => {
        await devices.create(newDevice("owner-a"));
        await credentials.issue({
          deviceId: DEVICE_A,
          credentialId: CREDENTIAL_A,
          secretDigest: DIGEST_A,
          createdAt: new Date(CREATED_AT_MS),
        });
        const results = await Promise.allSettled([
          credentials.rotate({
            deviceId: DEVICE_A,
            expectedCredentialId: CREDENTIAL_A,
            expectedVersion: 1,
            credentialId: CREDENTIAL_B,
            secretDigest: DIGEST_B,
            rotatedAt: new Date(CREATED_AT_MS + 1000),
          }),
          credentials.rotate({
            deviceId: DEVICE_A,
            expectedCredentialId: CREDENTIAL_A,
            expectedVersion: 1,
            credentialId: CREDENTIAL_C,
            secretDigest: DIGEST_C,
            rotatedAt: new Date(CREATED_AT_MS + 1000),
          }),
        ]);
        expect(
          results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        expect((await credentials.getActive(DEVICE_A))?.version).toBe(2);
        expect(await credentials.verify(DEVICE_A, DIGEST_A)).toBeNull();
        const winner = await credentials.getActive(DEVICE_A);
        expect(winner?.credentialId).toBe(
          results[0]?.status === "fulfilled" ? CREDENTIAL_B : CREDENTIAL_C,
        );
      });
    });

    test("pairing concurrent claim chỉ một request tạo device", async () => {
      await withHarness(factory, async ({ devices, pairings }, setNow) => {
        await pairings.create(newPairing(SESSION_A, DIGEST_A));
        setNow(CREATED_AT_MS + 1000);
        const results = await Promise.allSettled([
          pairings.claim(claim("owner-a", DIGEST_A)),
          pairings.claim(claim("owner-b", DIGEST_A)),
        ]);
        const successes = results.filter(
          (result) => result.status === "fulfilled",
        );
        expect(successes).toHaveLength(1);
        const claimed = await pairings.getById(SESSION_A);
        expect(claimed?.state).toBe("claimed");
        expect(claimed?.deviceId).toBeDefined();
        const ownerA = await devices.listByOwnerId("owner-a");
        const ownerB = await devices.listByOwnerId("owner-b");
        expect(ownerA.length + ownerB.length).toBe(1);
        expect(ownerA[0]?.deviceId ?? ownerB[0]?.deviceId).toBe(
          claimed?.deviceId,
        );
        await expect(
          pairings.claim(claim("owner-c", DIGEST_A)),
        ).rejects.toMatchObject({
          code: "PAIRING_CODE_UNAVAILABLE",
        });
      });
    });

    test("expired pairing không tạo device tại expiry boundary", async () => {
      await withHarness(factory, async ({ devices, pairings }, setNow) => {
        await pairings.create(newPairing(SESSION_A, DIGEST_A));
        setNow(CREATED_AT_MS + 60_000);
        await expect(
          pairings.claim(claim("owner-a", DIGEST_A)),
        ).rejects.toMatchObject({
          code: "PAIRING_CODE_UNAVAILABLE",
        });
        expect(await devices.listByOwnerId("owner-a")).toHaveLength(0);
        expect((await pairings.getById(SESSION_A))?.state).toBe("expired");
      });
    });

    test("device create lỗi phải giữ pairing pending để claim retry", async () => {
      let nextId = DEVICE_A;
      await withHarness(
        factory,
        async ({ devices, pairings }, setNow) => {
          await devices.create(newDevice("owner-a"));
          await pairings.create(newPairing(SESSION_A, DIGEST_A));
          setNow(CREATED_AT_MS + 1000);
          await expect(
            pairings.claim(claim("owner-b", DIGEST_A)),
          ).rejects.toMatchObject({
            code: "DEVICE_ALREADY_EXISTS",
          });
          expect((await pairings.getById(SESSION_A))?.state).toBe("pending");
          nextId = DEVICE_B;
          const result = await pairings.claim(claim("owner-b", DIGEST_A));
          expect(result.device.deviceId).toBe(DEVICE_B);
          expect(result.session.state).toBe("claimed");
        },
        () => nextId,
      );
    });

    test("cancel và expire giữ nguyên single-use pairing semantics", async () => {
      await withHarness(factory, async ({ pairings }, setNow) => {
        await pairings.create(newPairing(SESSION_A, DIGEST_A));
        await pairings.create(newPairing(SESSION_B, DIGEST_B));
        setNow(CREATED_AT_MS + 1000);
        expect(
          (await pairings.cancel(SESSION_A, new Date(CREATED_AT_MS + 1000)))
            .state,
        ).toBe("cancelled");
        await expect(
          pairings.claim(claim("owner-a", DIGEST_A)),
        ).rejects.toMatchObject({
          code: "PAIRING_CODE_UNAVAILABLE",
        });
        setNow(CREATED_AT_MS + 60_000);
        expect(await pairings.expire(new Date(CREATED_AT_MS + 60_000))).toBe(1);
        expect((await pairings.getById(SESSION_B))?.state).toBe("expired");
      });
    });
  });
}
