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
const CREDENTIAL_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
] as const;
const SECRETS = [
  "initial-pairing-secret",
  "explicit-rotate-secret",
  "unexpected-recovery-secret",
] as const;

async function createFixture() {
  const now = () => new Date("2026-09-16T08:00:00.000Z");
  let credentialIdIndex = 0;
  let secretIndex = 0;
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
    generateCredentialId: () =>
      CREDENTIAL_IDS[credentialIdIndex++] ?? crypto.randomUUID(),
    generateSecret: () => SECRETS[secretIndex++] ?? `secret-${secretIndex}`,
  });
  const completionRepository =
    new InMemoryPairingCredentialCompletionRepository();
  const completionService = new PairingCredentialCompletionService({
    pairingService,
    credentialService,
    deviceRepository,
    completionRepository,
  });

  const pairing = await pairingService.createPairingSession();
  const completed = await completionService.claimAndIssue(pairing.pairingCode, {
    ownerId: "owner-a",
    deviceName: "External mutation device",
    metadata: { platform: "linux-x64" },
  });

  return {
    deviceRepository,
    pairingService,
    credentialService,
    completionRepository,
    completed,
  };
}

function restartCompletionService(
  fixture: Awaited<ReturnType<typeof createFixture>>,
) {
  return new PairingCredentialCompletionService({
    pairingService: fixture.pairingService,
    credentialService: fixture.credentialService,
    deviceRepository: fixture.deviceRepository,
    completionRepository: fixture.completionRepository,
  });
}

describe("Pairing recovery vs explicit credential mutation", () => {
  test("revoke pending credential không bị resume issue lại", async () => {
    const fixture = await createFixture();
    await fixture.credentialService.revoke(DEVICE_ID);

    const restarted = restartCompletionService(fixture);
    await expect(
      restarted.resumeClaimedPairing(PAIRING_SESSION_ID, "owner-a"),
    ).rejects.toMatchObject({ code: "PAIRING_COMPLETION_UNAVAILABLE" });

    await expect(
      fixture.credentialService.verify(DEVICE_ID, fixture.completed.secret),
    ).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    await expect(
      fixture.credentialService.getActive(DEVICE_ID),
    ).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
  });

  test("explicit rotate pending credential giữ nguyên generation vừa trả cho caller", async () => {
    const fixture = await createFixture();
    const rotated = await fixture.credentialService.rotate(DEVICE_ID);

    const restarted = restartCompletionService(fixture);
    await expect(
      restarted.resumeClaimedPairing(PAIRING_SESSION_ID, "owner-a"),
    ).rejects.toMatchObject({ code: "PAIRING_COMPLETION_UNAVAILABLE" });

    await expect(
      fixture.credentialService.verify(DEVICE_ID, rotated.secret),
    ).resolves.toMatchObject({ credential: rotated.credential });
    await expect(
      fixture.credentialService.getActive(DEVICE_ID),
    ).resolves.toEqual(rotated.credential);
  });

  test("external rotate sau recovery reservation không bị nhận nhầm là recovery commit", async () => {
    const fixture = await createFixture();
    const reservation = await fixture.completionRepository.beginRecovery({
      pairingSessionId: PAIRING_SESSION_ID,
      deviceId: DEVICE_ID,
      credentialId: fixture.completed.credential.credentialId,
      credentialVersion: fixture.completed.credential.version,
      recoveryTargetCredentialId: CREDENTIAL_IDS[2],
    });
    expect(reservation).toMatchObject({
      state: "recovering",
      recoveryTargetCredentialId: CREDENTIAL_IDS[2],
    });

    const rotated = await fixture.credentialService.rotate(DEVICE_ID);
    expect(rotated.credential.credentialId).toBe(CREDENTIAL_IDS[1]);

    const restarted = restartCompletionService(fixture);
    await expect(
      restarted.resumeClaimedPairing(PAIRING_SESSION_ID, "owner-a"),
    ).rejects.toMatchObject({ code: "PAIRING_COMPLETION_UNAVAILABLE" });

    await expect(
      fixture.credentialService.verify(DEVICE_ID, rotated.secret),
    ).resolves.toMatchObject({ credential: rotated.credential });
    await expect(
      fixture.credentialService.getActive(DEVICE_ID),
    ).resolves.toEqual(rotated.credential);
  });
});
