import { describe, expect, test } from "bun:test";
import {
  DeviceCredentialService,
  InMemoryDeviceCredentialRepository,
} from "./device-credential";
import { InMemoryDeviceRepository } from "./device-repository";
import { InMemoryPairingSessionRepository, PairingService } from "./pairing";
import {
  InMemoryPairingCredentialCompletionRepository,
  PairingCredentialCompletionService,
} from "./pairing-credential-completion";

const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAIRING_SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";
const RAW_CREDENTIAL = "terminal-delivery-secret";

async function createFixture() {
  const now = () => new Date("2026-09-15T11:00:00.000Z");
  const deviceRepository = new InMemoryDeviceRepository({
    generateDeviceId: () => DEVICE_ID,
    now,
  });
  const pairingRepository = new InMemoryPairingSessionRepository(
    deviceRepository,
    { now },
  );
  const pairingService = new PairingService({
    repository: pairingRepository,
    now,
    generatePairingCode: () => "ABCDEFGHJKLM",
    generatePairingSessionId: () => PAIRING_SESSION_ID,
  });
  const credentialRepository = new InMemoryDeviceCredentialRepository();
  const credentialService = new DeviceCredentialService({
    repository: credentialRepository,
    deviceRepository,
    now,
    generateCredentialId: () => CREDENTIAL_ID,
    generateSecret: () => RAW_CREDENTIAL,
  });
  const completionRepository =
    new InMemoryPairingCredentialCompletionRepository();
  const completionService = new PairingCredentialCompletionService({
    pairingService,
    credentialService,
    deviceRepository,
    completionRepository,
  });

  const pairing = await pairingService.createPairingSession({
    localCorrelationId: "terminal-channel",
  });
  const completed = await completionService.claimAndIssue(pairing.pairingCode, {
    ownerId: "owner-a",
    deviceName: "Terminal device",
    metadata: { platform: "darwin-arm64" },
  });

  return {
    deviceRepository,
    pairingService,
    credentialService,
    completionRepository,
    completionService,
    completed,
  };
}

describe("Pairing credential terminal delivery", () => {
  test("wrong/stale ACK không consume pending delivery", async () => {
    const { completionRepository, completionService, completed } =
      await createFixture();

    await expect(
      completionService.acknowledgeDelivery({
        pairingSessionId: PAIRING_SESSION_ID,
        ownerId: "owner-b",
        credentialId: completed.credential.credentialId,
        credentialVersion: completed.credential.version,
      }),
    ).rejects.toMatchObject({ code: "PAIRING_COMPLETION_UNAVAILABLE" });

    await expect(
      completionService.acknowledgeDelivery({
        pairingSessionId: PAIRING_SESSION_ID,
        ownerId: "owner-a",
        credentialId: completed.credential.credentialId,
        credentialVersion: completed.credential.version + 1,
      }),
    ).rejects.toMatchObject({ code: "PAIRING_COMPLETION_UNAVAILABLE" });

    await expect(
      completionRepository.get(PAIRING_SESSION_ID),
    ).resolves.toMatchObject({
      state: "pending",
      credentialId: CREDENTIAL_ID,
      credentialVersion: 1,
    });
    await expect(
      completionService.resumeClaimedPairing(PAIRING_SESSION_ID, "owner-a"),
    ).resolves.toBe(completed);
  });

  test("ACK đúng generation idempotent và delivered terminal qua restart/revoke", async () => {
    const {
      deviceRepository,
      pairingService,
      credentialService,
      completionRepository,
      completionService,
      completed,
    } = await createFixture();
    const ack = {
      pairingSessionId: PAIRING_SESSION_ID,
      ownerId: "owner-a",
      credentialId: completed.credential.credentialId,
      credentialVersion: completed.credential.version,
    } as const;

    await expect(completionService.acknowledgeDelivery(ack)).resolves.toBeUndefined();
    await expect(completionService.acknowledgeDelivery(ack)).resolves.toBeUndefined();

    await expect(
      completionRepository.get(PAIRING_SESSION_ID),
    ).resolves.toMatchObject({
      state: "delivered",
      credentialId: CREDENTIAL_ID,
      credentialVersion: 1,
    });
    await expect(
      completionService.resumeClaimedPairing(PAIRING_SESSION_ID, "owner-a"),
    ).rejects.toMatchObject({ code: "PAIRING_COMPLETION_UNAVAILABLE" });

    const restarted = new PairingCredentialCompletionService({
      pairingService,
      credentialService,
      deviceRepository,
      completionRepository,
    });
    await expect(restarted.acknowledgeDelivery(ack)).resolves.toBeUndefined();
    await expect(
      restarted.resumeClaimedPairing(PAIRING_SESSION_ID, "owner-a"),
    ).rejects.toMatchObject({ code: "PAIRING_COMPLETION_UNAVAILABLE" });

    await credentialService.revoke(DEVICE_ID);
    await expect(
      restarted.resumeClaimedPairing(PAIRING_SESSION_ID, "owner-a"),
    ).rejects.toMatchObject({ code: "PAIRING_COMPLETION_UNAVAILABLE" });
    await expect(
      credentialService.verify(DEVICE_ID, RAW_CREDENTIAL),
    ).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
  });
});
