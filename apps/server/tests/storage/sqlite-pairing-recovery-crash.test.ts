import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeviceCredentialService,
  type IssuedDeviceCredential,
} from "../../src/device-credential";
import { PairingCredentialCompletionService } from "../../src/pairing-credential-completion";
import { PairingService } from "../../src/pairing";
import {
  openSqliteServerStorage,
  type SqliteServerStorage,
} from "../../src/storage/sqlite-server-storage";

const OWNER = "owner-recovery";
const TARGET = "99999999-9999-4999-8999-999999999999";
const TEMP_DIGEST = "f".repeat(64);
const roots: string[] = [];

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "doctmcp-m6-crash-"));
  roots.push(root);
  return join(root, "persist");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

function services(storage: SqliteServerStorage) {
  const pairing = new PairingService({ repository: storage.pairingRepository });
  const credentials = new DeviceCredentialService({
    repository: storage.credentialRepository,
    deviceRepository: storage.deviceRepository,
  });
  const completion = new PairingCredentialCompletionService({
    pairingService: pairing,
    credentialService: credentials,
    deviceRepository: storage.deviceRepository,
    completionRepository: storage.pairingCredentialCompletionRepository,
  });
  return { pairing, credentials, completion };
}

async function claimOnly(storage: SqliteServerStorage) {
  const { pairing } = services(storage);
  const created = await pairing.createPairingSession();
  const claimed = await pairing.claimPairingCode(created.pairingCode, {
    ownerId: OWNER,
    deviceName: "Crash recovery",
    metadata: { platform: "linux-x64" },
  });
  return claimed;
}

describe("M6 SQLite credential crash windows", () => {
  test("restart sau claim nhưng trước issue tiếp tục issue đúng một credential", async () => {
    const dataDir = await directory();
    const first = await openSqliteServerStorage({ dataDir });
    let pairingSessionId: string;
    let deviceId: string;
    try {
      const claimed = await claimOnly(first);
      pairingSessionId = claimed.session.pairingSessionId;
      deviceId = claimed.device.deviceId;
      expect(await first.credentialRepository.getActive(deviceId)).toBeNull();
    } finally {
      first.close();
    }
    const second = await openSqliteServerStorage({ dataDir });
    try {
      const { completion, credentials } = services(second);
      const resumed = await completion.resumeClaimedPairing(pairingSessionId, OWNER);
      expect(resumed.device.deviceId).toBe(deviceId);
      expect(resumed.credential.version).toBe(1);
      expect((await credentials.verify(deviceId, resumed.secret)).credential.version).toBe(1);
      expect((await second.pairingCredentialCompletionRepository.get(pairingSessionId))?.state)
        .toBe("pending");
    } finally {
      second.close();
    }
  });

  test("restart sau issue nhưng trước setPending rotate secret cũ an toàn", async () => {
    const dataDir = await directory();
    const first = await openSqliteServerStorage({ dataDir });
    let pairingSessionId: string;
    let deviceId: string;
    let issued: IssuedDeviceCredential;
    try {
      const claimed = await claimOnly(first);
      pairingSessionId = claimed.session.pairingSessionId;
      deviceId = claimed.device.deviceId;
      issued = await services(first).credentials.issue(deviceId);
      expect(await first.pairingCredentialCompletionRepository.get(pairingSessionId))
        .toBeNull();
    } finally {
      first.close();
    }
    const second = await openSqliteServerStorage({ dataDir });
    try {
      const { completion, credentials } = services(second);
      const resumed = await completion.resumeClaimedPairing(pairingSessionId, OWNER);
      expect(resumed.credential.version).toBe(issued.credential.version + 1);
      await expect(credentials.verify(deviceId, issued.secret)).rejects.toMatchObject({
        code: "CREDENTIAL_UNAVAILABLE",
      });
      expect((await credentials.verify(deviceId, resumed.secret)).credential.version)
        .toBe(2);
      await completion.acknowledgeDelivery({
        pairingSessionId, ownerId: OWNER,
        credentialId: resumed.credential.credentialId,
        credentialVersion: resumed.credential.version,
      });
    } finally {
      second.close();
    }
  });

  test("restart sau reserved rotate nhưng trước finalize không phát lại secret đã mất", async () => {
    const dataDir = await directory();
    const first = await openSqliteServerStorage({ dataDir });
    let pairingSessionId: string;
    let deviceId: string;
    let issued: IssuedDeviceCredential;
    try {
      const claimed = await claimOnly(first);
      pairingSessionId = claimed.session.pairingSessionId;
      deviceId = claimed.device.deviceId;
      issued = await services(first).credentials.issue(deviceId);
      await first.pairingCredentialCompletionRepository.reserve(pairingSessionId);
      await first.pairingCredentialCompletionRepository.setPending({
        pairingSessionId, deviceId,
        credentialId: issued.credential.credentialId,
        credentialVersion: issued.credential.version,
      });
      expect((await first.pairingCredentialCompletionRepository.beginRecovery({
        pairingSessionId, deviceId,
        credentialId: issued.credential.credentialId,
        credentialVersion: issued.credential.version,
        recoveryTargetCredentialId: TARGET,
      }))?.state).toBe("recovering");
      const target = await first.credentialRepository.rotate({
        deviceId,
        expectedCredentialId: issued.credential.credentialId,
        expectedVersion: issued.credential.version,
        credentialId: TARGET, secretDigest: TEMP_DIGEST,
        rotatedAt: new Date(Date.now() + 1000),
      });
      expect(target.version).toBe(2);
    } finally {
      first.close();
    }
    const second = await openSqliteServerStorage({ dataDir });
    try {
      const { completion, credentials } = services(second);
      const resumed = await completion.resumeClaimedPairing(pairingSessionId, OWNER);
      expect(resumed.credential.version).toBe(3);
      expect(resumed.credential.credentialId).not.toBe(TARGET);
      await expect(credentials.verify(deviceId, issued.secret))
        .rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
      expect(await second.credentialRepository.verify(deviceId, TEMP_DIGEST)).toBeNull();
      expect((await credentials.verify(deviceId, resumed.secret)).credential.version)
        .toBe(3);
    } finally {
      second.close();
    }
  });
});
