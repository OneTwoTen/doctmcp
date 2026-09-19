import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeviceCredentialService,
  digestDeviceCredentialSecret,
} from "../../src/device-credential";
import { SqliteDeviceCredentialRepository } from "../../src/storage/sqlite-device-credential-repository";
import { SqliteDeviceRepository } from "../../src/storage/sqlite-device-repository";
import { openSqliteDatabase } from "../../src/storage/sqlite-database";

const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREDENTIAL_A = "11111111-1111-4111-8111-111111111111";
const CREDENTIAL_B = "22222222-2222-4222-8222-222222222222";
const CREDENTIAL_C = "33333333-3333-4333-8333-333333333333";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const CREATED_AT = new Date("2026-09-19T04:00:00.000Z");
const roots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "doctmcp-credential-"));
  roots.push(root);
  return join(root, "data");
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function withRepositories(
  run: (
    device: SqliteDeviceRepository,
    credentials: SqliteDeviceCredentialRepository,
  ) => Promise<void>,
): Promise<void> {
  const db = await openSqliteDatabase({ dataDir: await tempDir() });
  try {
    await run(
      new SqliteDeviceRepository(db.database, {
        generateDeviceId: () => DEVICE_A,
      }),
      new SqliteDeviceCredentialRepository(db.database),
    );
  } finally {
    db.close();
  }
}

async function addDevice(repo: SqliteDeviceRepository): Promise<void> {
  await repo.create({
    ownerId: "owner-a",
    deviceName: "Device",
    metadata: { platform: "linux-x64" },
  });
}

describe("M6.4 SQLite credential repository", () => {
  test("issue, revoke, reissue và rotate giữ generation monotonic và ID không tái sử dụng", async () => {
    await withRepositories(async (device, credentials) => {
      await addDevice(device);
      const first = await credentials.issue({
        deviceId: DEVICE_A,
        credentialId: CREDENTIAL_A,
        secretDigest: DIGEST_A,
        createdAt: CREATED_AT,
      });
      expect(first.version).toBe(1);
      expect(JSON.stringify(first)).not.toContain(DIGEST_A);
      await expect(
        credentials.issue({
          deviceId: DEVICE_A,
          credentialId: CREDENTIAL_B,
          secretDigest: DIGEST_B,
          createdAt: CREATED_AT,
        }),
      ).rejects.toMatchObject({ code: "CREDENTIAL_ALREADY_EXISTS" });
      expect((await credentials.verify(DEVICE_A, DIGEST_A))?.credentialId).toBe(
        CREDENTIAL_A,
      );
      expect(await credentials.verify(DEVICE_A, DIGEST_B)).toBeNull();
      expect(
        (
          await credentials.revoke({
            deviceId: DEVICE_A,
            expectedCredentialId: CREDENTIAL_A,
            expectedVersion: 1,
            revokedAt: new Date(CREATED_AT.getTime() + 1000),
          })
        )?.state,
      ).toBe("revoked");
      expect(await credentials.verify(DEVICE_A, DIGEST_A)).toBeNull();
      await expect(
        credentials.issue({
          deviceId: DEVICE_A,
          credentialId: CREDENTIAL_A,
          secretDigest: DIGEST_B,
          createdAt: new Date(CREATED_AT.getTime() + 2000),
        }),
      ).rejects.toMatchObject({ code: "CREDENTIAL_ID_CONFLICT" });
      const second = await credentials.issue({
        deviceId: DEVICE_A,
        credentialId: CREDENTIAL_B,
        secretDigest: DIGEST_B,
        createdAt: new Date(CREATED_AT.getTime() + 2000),
      });
      expect(second.version).toBe(2);
      expect(
        await credentials.revoke({
          deviceId: DEVICE_A,
          expectedCredentialId: CREDENTIAL_A,
          expectedVersion: 1,
          revokedAt: new Date(CREATED_AT.getTime() + 3000),
        }),
      ).toBeNull();
      const third = await credentials.rotate({
        deviceId: DEVICE_A,
        expectedCredentialId: CREDENTIAL_B,
        expectedVersion: 2,
        credentialId: CREDENTIAL_C,
        secretDigest: DIGEST_C,
        rotatedAt: new Date(CREATED_AT.getTime() + 3000),
      });
      expect(third.version).toBe(3);
      expect(await credentials.verify(DEVICE_A, DIGEST_B)).toBeNull();
      expect((await credentials.verify(DEVICE_A, DIGEST_C))?.version).toBe(3);
      await expect(
        credentials.rotate({
          deviceId: DEVICE_A,
          expectedCredentialId: CREDENTIAL_B,
          expectedVersion: 2,
          credentialId: CREDENTIAL_A,
          secretDigest: DIGEST_A,
          rotatedAt: new Date(CREATED_AT.getTime() + 4000),
        }),
      ).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    });
  });

  test("concurrent issue và rotate chỉ một generation thành công", async () => {
    await withRepositories(async (device, credentials) => {
      await addDevice(device);
      const issued = await Promise.allSettled([
        credentials.issue({
          deviceId: DEVICE_A,
          credentialId: CREDENTIAL_A,
          secretDigest: DIGEST_A,
          createdAt: CREATED_AT,
        }),
        credentials.issue({
          deviceId: DEVICE_A,
          credentialId: CREDENTIAL_B,
          secretDigest: DIGEST_B,
          createdAt: CREATED_AT,
        }),
      ]);
      expect(
        issued.filter((result) => result.status === "fulfilled"),
      const current = await credentials.getActive(DEVICE_A);
      expect(current?.version).toBe(1);
      if (!current) throw new Error("Missing credential after issue");
      const rotated = await Promise.allSettled([
        credentials.rotate({ deviceId: DEVICE_A, expectedCredentialId: current.credentialId,
          expectedVersion: 1, credentialId: CREDENTIAL_C, secretDigest: DIGEST_C,
          rotatedAt: new Date(CREATED_AT.getTime() + 1000) }),
        credentials.rotate({ deviceId: DEVICE_A, expectedCredentialId: current.credentialId,
          expectedVersion: 1, credentialId: current.credentialId === CREDENTIAL_A
            ? CREDENTIAL_B : CREDENTIAL_A,
          secretDigest: DIGEST_B, rotatedAt: new Date(CREATED_AT.getTime() + 1000) }),
      ]);
      expect(rotated.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect((await credentials.getActive(DEVICE_A))?.version).toBe(2);
    });
  });

  test("valid credential xác thực lại qua database reopen; revoked không thể reconnect", async () => {
    const directory = await tempDir();
    const first = await openSqliteDatabase({ dataDir: directory });
    const rawSecret = "local-test-secret-not-a-production-credential";
    const digest = await digestDeviceCredentialSecret(rawSecret);
    try {
      const device = new SqliteDeviceRepository(first.database, {
        generateDeviceId: () => DEVICE_A,
      });
      await addDevice(device);
      const credentials = new SqliteDeviceCredentialRepository(first.database);
      await credentials.issue({
        deviceId: DEVICE_A, credentialId: CREDENTIAL_A,
        secretDigest: digest, createdAt: CREATED_AT,
      });
      const stored = first.database.query(
        "SELECT secret_digest FROM device_credentials WHERE device_id = ?1",
      ).get(DEVICE_A) as { secret_digest: string };
      expect(stored.secret_digest).toBe(digest);
      expect(JSON.stringify(stored)).not.toContain(rawSecret);
    } finally {
      first.close();
    }

    const second = await openSqliteDatabase({ dataDir: directory });
    try {
      const credentials = new SqliteDeviceCredentialRepository(second.database);
      const device = new SqliteDeviceRepository(second.database);
      const service = new DeviceCredentialService({
        repository: credentials, deviceRepository: device,
      });
      expect((await service.verify(DEVICE_A, rawSecret)).identity).toEqual({
        deviceId: DEVICE_A, ownerId: "owner-a",
      });
      await expect(service.verify(DEVICE_A, "incorrect")).rejects.toMatchObject({
        code: "CREDENTIAL_UNAVAILABLE",
      });
      expect((await credentials.revoke({
        deviceId: DEVICE_A, expectedCredentialId: CREDENTIAL_A,
        expectedVersion: 1, revokedAt: new Date(CREATED_AT.getTime() + 1000),
      }))?.state).toBe("revoked");
    } finally {
      second.close();
    }
    const third = await openSqliteDatabase({ dataDir: directory });
    try {
      const service = new DeviceCredentialService({
        repository: new SqliteDeviceCredentialRepository(third.database),
        deviceRepository: new SqliteDeviceRepository(third.database),
      });
      await expect(service.verify(DEVICE_A, rawSecret)).rejects.toMatchObject({
        code: "CREDENTIAL_UNAVAILABLE",
      });
    } finally {
      third.close();
    }
  });

  test("global credential IDs giữ unique across devices và restart", async () => {
    const directory = await tempDir();
    const db = await openSqliteDatabase({ dataDir: directory });
    try {
      const device = new SqliteDeviceRepository(db.database, {
        generateDeviceId: () => DEVICE_A,
      });
      await addDevice(device);
      const another = new SqliteDeviceRepository(db.database, {
        generateDeviceId: () => DEVICE_B,
      });
      await another.create({ ownerId: "owner-b", deviceName: "Second",
        metadata: { platform: "linux-x64" } });
      const credentials = new SqliteDeviceCredentialRepository(db.database);
      await credentials.issue({ deviceId: DEVICE_A, credentialId: CREDENTIAL_A,
        secretDigest: DIGEST_A, createdAt: CREATED_AT });
      await expect(credentials.issue({ deviceId: DEVICE_B, credentialId: CREDENTIAL_A,
        secretDigest: DIGEST_B, createdAt: CREATED_AT }))
        .rejects.toMatchObject({ code: "CREDENTIAL_ID_CONFLICT" });
    } finally {
      db.close();
    }
    const opened = await openSqliteDatabase({ dataDir: directory });
    try {
      expect(
        (await new SqliteDeviceCredentialRepository(opened.database)
          .getActive(DEVICE_A))?.credentialId,
      ).toBe(CREDENTIAL_A);
    } finally {
      opened.close();
    }
  });
});
