import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceCredentialService } from "../../src/device-credential";
import { PairingCredentialCompletionService } from "../../src/pairing-credential-completion";
import { PairingService } from "../../src/pairing";
import { openSqliteDatabase } from "../../src/storage/sqlite-database";
import { SqliteDeviceCredentialRepository } from "../../src/storage/sqlite-device-credential-repository";
import { SqliteDeviceRepository } from "../../src/storage/sqlite-device-repository";
import { SqlitePairingCredentialCompletionRepository } from "../../src/storage/sqlite-pairing-credential-completion-repository";
import { SqlitePairingSessionRepository } from "../../src/storage/sqlite-pairing-repository";
import { describePersistentRepositoryContract } from "../contracts/persistent-repository-contract-suite";

const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_A = "44444444-4444-4444-8444-444444444444";
const DIGEST_A = "a".repeat(64);
const TIME = Date.parse("2026-09-19T04:00:00.000Z");
const roots: string[] = [];

async function dataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "doctmcp-m6-pairing-"));
  roots.push(root);
  return join(root, "persistent");
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

function deviceInput(ownerId = "owner-a") {
  return { ownerId, deviceName: "Paired device", metadata: { platform: "linux-x64" } };
}

describePersistentRepositoryContract("SQLite", async ({ now, generateDeviceId }) => {
  const db = await openSqliteDatabase({ dataDir: await dataDir() });
  const devices = new SqliteDeviceRepository(db.database, { now, generateDeviceId });
  return {
    devices,
    credentials: new SqliteDeviceCredentialRepository(db.database),
    pairings: new SqlitePairingSessionRepository(db.database, devices, { now }),
    close: () => db.close(),
  };
});

describe("M6.5 durable pairing integration", () => {
  test("pending session survives close/reopen and is claimed only once", async () => {
    const directory = await dataDir();
    const first = await openSqliteDatabase({ dataDir: directory });
    try {
      const devices = new SqliteDeviceRepository(first.database, {
        generateDeviceId: () => DEVICE_A,
      });
      await new SqlitePairingSessionRepository(first.database, devices).create({
        pairingSessionId: SESSION_A, codeDigest: DIGEST_A,
        createdAt: new Date(TIME), expiresAt: new Date(TIME + 60_000),
      });
    } finally {
      first.close();
    }
    const second = await openSqliteDatabase({ dataDir: directory });
    try {
      const devices = new SqliteDeviceRepository(second.database, {
        generateDeviceId: () => DEVICE_A,
      });
      const pairings = new SqlitePairingSessionRepository(second.database, devices, {
        now: () => new Date(TIME + 1_000),
      });
      expect((await pairings.getById(SESSION_A))?.state).toBe("pending");
      const claimed = await pairings.claim({ ...deviceInput(), codeDigest: DIGEST_A });
      expect(claimed.session.state).toBe("claimed");
      expect(claimed.device.deviceId).toBe(DEVICE_A);
      await expect(pairings.claim({ ...deviceInput(), codeDigest: DIGEST_A }))
        .rejects.toMatchObject({ code: "PAIRING_CODE_UNAVAILABLE" });
    } finally {
      second.close();
    }
  });

  test("fault injection SAU device insert rollback cả claim và device trên SQLite thật", async () => {
    const directory = await dataDir();
    const first = await openSqliteDatabase({ dataDir: directory });
    try {
      const devices = new SqliteDeviceRepository(first.database, {
        generateDeviceId: () => DEVICE_A,
      });
      const pairings = new SqlitePairingSessionRepository(first.database, devices, {
        now: () => new Date(TIME + 1000),
      });
      await pairings.create({
        pairingSessionId: SESSION_A, codeDigest: DIGEST_A,
        createdAt: new Date(TIME), expiresAt: new Date(TIME + 60_000),
      });
      first.database.exec(`CREATE TRIGGER abort_claim AFTER UPDATE OF state
        ON pairing_sessions WHEN NEW.state = 'claimed'
        BEGIN SELECT RAISE(ABORT, 'fault after device insert'); END;`);
      await expect(pairings.claim({ ...deviceInput(), codeDigest: DIGEST_A }))
        .rejects.toThrow("fault after device insert");
    } finally {
      first.close();
    }

    const second = await openSqliteDatabase({ dataDir: directory });
    try {
      const devices = new SqliteDeviceRepository(second.database, {
        generateDeviceId: () => DEVICE_A,
      });
      const pairings = new SqlitePairingSessionRepository(second.database, devices, {
        now: () => new Date(TIME + 2000),
      });
      expect(await devices.listByOwnerId("owner-a")).toHaveLength(0);
      expect((await pairings.getById(SESSION_A))?.state).toBe("pending");
      second.database.exec("DROP TRIGGER abort_claim;");
      const claimed = await pairings.claim({ ...deviceInput(), codeDigest: DIGEST_A });
      expect(claimed.device.deviceId).toBe(DEVICE_A);
      expect((await pairings.getById(SESSION_A))?.state).toBe("claimed");
      expect(await devices.listByOwnerId("owner-a")).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  test("expired, pruned, and reused digests stay unavailable across reconnect", async () => {
    const directory = await dataDir();
    const first = await openSqliteDatabase({ dataDir: directory });
    try {
      const devices = new SqliteDeviceRepository(first.database);
      const pairings = new SqlitePairingSessionRepository(first.database, devices, {
        now: () => new Date(TIME + 60_000),
      });
      await pairings.create({
        pairingSessionId: SESSION_A, codeDigest: DIGEST_A,
        createdAt: new Date(TIME), expiresAt: new Date(TIME + 60_000),
      });
      await expect(pairings.claim({ ...deviceInput(), codeDigest: DIGEST_A }))
        .rejects.toMatchObject({ code: "PAIRING_CODE_UNAVAILABLE" });
      expect((await pairings.getById(SESSION_A))?.state).toBe("expired");
      expect(await pairings.pruneExpired(new Date(TIME + 60_000))).toBe(1);
    } finally {
      first.close();
    }
    const second = await openSqliteDatabase({ dataDir: directory });
    try {
      const pairings = new SqlitePairingSessionRepository(second.database,
        new SqliteDeviceRepository(second.database));
      await expect(pairings.create({
        pairingSessionId: "55555555-5555-4555-8555-555555555555",
        codeDigest: DIGEST_A, createdAt: new Date(TIME + 100_000),
        expiresAt: new Date(TIME + 160_000),
      })).rejects.toMatchObject({ code: "PAIRING_CODE_DIGEST_ALREADY_EXISTS" });
      expect(await pairings.getById(SESSION_A)).toBeNull();
    } finally {
      second.close();
    }
  });

  test("completion pending, recovery, and ACK survive restart without raw secrets stored", async () => {
    const directory = await dataDir();
    const first = await openSqliteDatabase({ dataDir: directory });
    let pairingSessionId: string;
    let oldSecret: string;
    try {
      const devices = new SqliteDeviceRepository(first.database, {
        generateDeviceId: () => DEVICE_A,
      });
      const pairings = new PairingService({
        repository: new SqlitePairingSessionRepository(first.database, devices, {
          now: () => new Date(TIME + 1000),
        }),
        now: () => new Date(TIME),
        generatePairingCode: () => "AAAA-BBBB-CCCC",
        generatePairingSessionId: () => SESSION_A,
      });
      const credentialService = new DeviceCredentialService({
        repository: new SqliteDeviceCredentialRepository(first.database),
        deviceRepository: devices,
        now: () => new Date(TIME + 1000),
      });
      const completion = new PairingCredentialCompletionService({
        pairingService: pairings, credentialService, deviceRepository: devices,
        completionRepository: new SqlitePairingCredentialCompletionRepository(first.database, {
          now: () => new Date(TIME + 1000),
        }),
      });
      const session = await pairings.createPairingSession();
      const issued = await completion.claimAndIssue(session.pairingCode, deviceInput());
      pairingSessionId = issued.session.pairingSessionId;
      oldSecret = issued.secret;
      expect(issued.device.deviceId).toBe(DEVICE_A);
      expect((await new SqlitePairingCredentialCompletionRepository(first.database, {
        now: () => new Date(TIME + 1000),
      }).get(pairingSessionId))?.state).toBe("pending");
      const dbText = JSON.stringify(first.database.query(
        "SELECT * FROM pairing_credential_completions",
      ).all());
      expect(dbText).not.toContain(oldSecret);
    } finally {
      first.close();
    }

    const second = await openSqliteDatabase({ dataDir: directory });
    let newSecret: string;
    let newCredentialId: string;
    let newVersion: number;
    try {
      const devices = new SqliteDeviceRepository(second.database);
      const pairings = new PairingService({
        repository: new SqlitePairingSessionRepository(second.database, devices, {
          now: () => new Date(TIME + 2000),
        }),
        now: () => new Date(TIME + 2000),
      });
      const credentialService = new DeviceCredentialService({
        repository: new SqliteDeviceCredentialRepository(second.database),
        deviceRepository: devices,
        now: () => new Date(TIME + 2000),
      });
      const completion = new PairingCredentialCompletionService({
        pairingService: pairings, credentialService, deviceRepository: devices,
        completionRepository: new SqlitePairingCredentialCompletionRepository(second.database, {
          now: () => new Date(TIME + 2000),
        }),
      });
      const resumed = await completion.resumeClaimedPairing(pairingSessionId, "owner-a");
      newSecret = resumed.secret;
      newCredentialId = resumed.credential.credentialId;
      newVersion = resumed.credential.version;
      expect(newVersion).toBe(2);
      await expect(credentialService.verify(DEVICE_A, oldSecret))
        .rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
      expect((await credentialService.verify(DEVICE_A, newSecret)).credential.version).toBe(2);
      await completion.acknowledgeDelivery({
        pairingSessionId, ownerId: "owner-a",
        credentialId: newCredentialId, credentialVersion: newVersion,
      });
    } finally {
      second.close();
    }

    const third = await openSqliteDatabase({ dataDir: directory });
    try {
      const devices = new SqliteDeviceRepository(third.database);
      const pairings = new PairingService({
        repository: new SqlitePairingSessionRepository(third.database, devices),
      });
      const credentials = new DeviceCredentialService({
        repository: new SqliteDeviceCredentialRepository(third.database),
        deviceRepository: devices,
      });
      const completion = new PairingCredentialCompletionService({
        pairingService: pairings, credentialService: credentials, deviceRepository: devices,
        completionRepository: new SqlitePairingCredentialCompletionRepository(third.database, {
          now: () => new Date(TIME + 3000),
        }),
      });
      await expect(completion.resumeClaimedPairing(pairingSessionId, "owner-a"))
        .rejects.toMatchObject({ code: "PAIRING_COMPLETION_UNAVAILABLE" });
      expect((await credentials.verify(DEVICE_A, newSecret)).identity.ownerId).toBe("owner-a");
    } finally {
      third.close();
    }
  });
});
