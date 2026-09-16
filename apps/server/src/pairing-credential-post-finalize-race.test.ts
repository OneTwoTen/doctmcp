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
] as const;
const SECRETS = ["initial-secret", "recovery-secret"] as const;

describe("Pairing recovery post-finalize validation", () => {
  test("revoke chen sau recovery rotate không làm lộ raw secret đã mất hiệu lực", async () => {
    const now = () => new Date("2026-09-16T11:30:00.000Z");
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
    const credentialService = new DeviceCredentialService({
      repository: new InMemoryDeviceCredentialRepository(),
      deviceRepository,
      now,
      generateCredentialId: () =>
        CREDENTIAL_IDS[credentialIdIndex++] ?? crypto.randomUUID(),
      generateSecret: () => SECRETS[secretIndex++] ?? `secret-${secretIndex}`,
    });
    const completionRepository =
      new InMemoryPairingCredentialCompletionRepository();

    const initialService = new PairingCredentialCompletionService({
      pairingService,
      credentialService,
      deviceRepository,
      completionRepository,
    });
    const pairing = await pairingService.createPairingSession();
    await initialService.claimAndIssue(pairing.pairingCode, {
      ownerId: "owner-a",
      deviceName: "Race device",
      metadata: { platform: "linux-x64" },
    });

    const restarted = new PairingCredentialCompletionService({
      pairingService,
      credentialService,
      deviceRepository,
      completionRepository,
      recoverExistingCredential: async (
        deviceId,
        expectedCredentialId,
        expectedCredentialVersion,
        credentialId,
      ) => {
        const issued = await credentialService.rotateExpectedWithCredentialId(
          deviceId,
          expectedCredentialId,
          expectedCredentialVersion,
          credentialId,
        );
        // Deterministically model an explicit lifecycle mutation in the exact
        // window after recovery rotate and before finishRecovery/delivery.
        await credentialService.revoke(deviceId);
        return issued;
      },
    });

    await expect(
      restarted.resumeClaimedPairing(PAIRING_SESSION_ID, "owner-a"),
    ).rejects.toMatchObject({ code: "PAIRING_COMPLETION_UNAVAILABLE" });

    await expect(credentialService.getActive(DEVICE_ID)).rejects.toMatchObject({
      code: "CREDENTIAL_UNAVAILABLE",
    });
    await expect(
      credentialService.verify(DEVICE_ID, SECRETS[1]),
    ).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
  });
});
