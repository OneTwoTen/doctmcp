import { describe, expect, test } from "bun:test";
import {
  DeviceCredentialService,
  InMemoryDeviceCredentialRepository,
} from "./device-credential";
import { InMemoryDeviceRepository } from "./device-repository";
import { InMemoryPairingSessionRepository, PairingService } from "./pairing";
import {
  PairingCredentialCompletionService,
  toPairingCredentialDelivery,
} from "./pairing-credential-completion";

const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAIRING_SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";
const RAW_CREDENTIAL = "issued-only-once-secret";

async function createFixture() {
  let now = new Date("2026-09-15T08:00:00.000Z");
  const devices = new InMemoryDeviceRepository({
    generateDeviceId: () => DEVICE_ID,
    now: () => now,
  });
  const pairingRepository = new InMemoryPairingSessionRepository(devices, {
    now: () => now,
  });
  const pairingService = new PairingService({
    repository: pairingRepository,
    now: () => now,
    generatePairingCode: () => "ABCDEFGHJKLM",
    generatePairingSessionId: () => PAIRING_SESSION_ID,
  });
  const credentialRepository = new InMemoryDeviceCredentialRepository();
  const credentialService = new DeviceCredentialService({
    repository: credentialRepository,
    deviceRepository: devices,
    now: () => now,
    generateCredentialId: () => CREDENTIAL_ID,
    generateSecret: () => RAW_CREDENTIAL,
  });
  const completionService = new PairingCredentialCompletionService({
    pairingService,
    credentialService,
  });

  const created = await pairingService.createPairingSession({
    localCorrelationId: "local-pairing-channel-1",
  });
  now = new Date("2026-09-15T08:01:00.000Z");

  return {
    created,
    credentialRepository,
    credentialService,
    completionService,
  };
}

describe("PairingCredentialCompletionService", () => {
  test("claim tạo đúng device rồi issue credential một lần cho đúng pairing channel", async () => {
    const { created, credentialService, completionService } =
      await createFixture();

    const completed = await completionService.claimAndIssue(
      created.pairingCode,
      {
        ownerId: "owner-a",
        deviceName: "DoCT Mac",
        metadata: { platform: "darwin-arm64" },
      },
    );

    expect(completed.session).toMatchObject({
      pairingSessionId: PAIRING_SESSION_ID,
      state: "claimed",
      localCorrelationId: "local-pairing-channel-1",
      deviceId: DEVICE_ID,
    });
    expect(completed.device).toMatchObject({
      deviceId: DEVICE_ID,
      ownerId: "owner-a",
    });
    expect(completed.credential).toMatchObject({
      credentialId: CREDENTIAL_ID,
      deviceId: DEVICE_ID,
      version: 1,
      state: "active",
    });
    expect(completed.secret).toBe(RAW_CREDENTIAL);

    await expect(
      credentialService.verify(DEVICE_ID, RAW_CREDENTIAL),
    ).resolves.toMatchObject({
      identity: { ownerId: "owner-a", deviceId: DEVICE_ID },
    });

    expect(toPairingCredentialDelivery(completed)).toEqual({
      pairingSessionId: PAIRING_SESSION_ID,
      localCorrelationId: "local-pairing-channel-1",
      deviceId: DEVICE_ID,
      credentialId: CREDENTIAL_ID,
      credentialVersion: 1,
      credential: RAW_CREDENTIAL,
    });
  });

  test("duplicate pairing claim dừng trước credential issue thứ hai", async () => {
    const { created, credentialRepository, completionService } =
      await createFixture();
    const input = {
      ownerId: "owner-a",
      deviceName: "DoCT Mac",
      metadata: { platform: "darwin-arm64" },
    } as const;

    await completionService.claimAndIssue(created.pairingCode, input);
    await expect(
      completionService.claimAndIssue(created.pairingCode, input),
    ).rejects.toMatchObject({
      code: "PAIRING_CODE_UNAVAILABLE",
    });

    await expect(
      credentialRepository.getActive(DEVICE_ID),
    ).resolves.toMatchObject({
      credentialId: CREDENTIAL_ID,
      version: 1,
      state: "active",
    });
  });
});
