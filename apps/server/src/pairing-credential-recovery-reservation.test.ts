import { describe, expect, test } from "bun:test";
import {
  DeviceCredentialService,
  InMemoryDeviceCredentialRepository,
} from "./device-credential";
import { InMemoryDeviceRepository } from "./device-repository";
import { InMemoryPairingSessionRepository, PairingService } from "./pairing";
import {
  InMemoryPairingCredentialCompletionRepository,
  type PairingCredentialCompletionRecord,
  type PairingCredentialCompletionRepository,
  PairingCredentialCompletionService,
} from "./pairing-credential-completion";

const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAIRING_SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREDENTIAL_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
] as const;
const SECRETS = [
  "secret-generation-1",
  "secret-generation-2",
  "secret-generation-3",
] as const;

class FailFirstFinishRepository
  implements PairingCredentialCompletionRepository
{
  #failNextFinish = true;

  constructor(
    private readonly delegate: PairingCredentialCompletionRepository,
  ) {}

  reserve(pairingSessionId: string) {
    return this.delegate.reserve(pairingSessionId);
  }

  get(pairingSessionId: string) {
    return this.delegate.get(pairingSessionId);
  }

  setPending(
    input: Parameters<PairingCredentialCompletionRepository["setPending"]>[0],
  ) {
    return this.delegate.setPending(input);
  }

  beginRecovery(
    input: Parameters<
      PairingCredentialCompletionRepository["beginRecovery"]
    >[0],
  ) {
    return this.delegate.beginRecovery(input);
  }

  advanceRecovery(
    input: Parameters<
      PairingCredentialCompletionRepository["advanceRecovery"]
    >[0],
  ) {
    return this.delegate.advanceRecovery(input);
  }

  async finishRecovery(
    input: Parameters<
      PairingCredentialCompletionRepository["finishRecovery"]
    >[0],
  ): Promise<PairingCredentialCompletionRecord | null> {
    if (this.#failNextFinish) {
      this.#failNextFinish = false;
      throw new Error("simulated crash after credential rotation");
    }
    return this.delegate.finishRecovery(input);
  }

  acknowledge(
    input: Parameters<PairingCredentialCompletionRepository["acknowledge"]>[0],
  ) {
    return this.delegate.acknowledge(input);
  }

  delete(pairingSessionId: string) {
    return this.delegate.delete(pairingSessionId);
  }
}

async function createFixture() {
  const now = () => new Date("2026-09-16T03:30:00.000Z");
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
  const initialService = new PairingCredentialCompletionService({
    pairingService,
    credentialService,
    deviceRepository,
    completionRepository,
  });

  const pairing = await pairingService.createPairingSession();
  const initial = await initialService.claimAndIssue(pairing.pairingCode, {
    ownerId: "owner-a",
    deviceName: "Recovery device",
    metadata: { platform: "linux-x64" },
  });

  return {
    deviceRepository,
    pairingService,
    credentialService,
    completionRepository,
    initial,
  };
}

describe("Pairing credential recovery reservation", () => {
  test("crash sau rotate không cho ACK generation cũ và resume tạo generation deliverable mới", async () => {
    const {
      deviceRepository,
      pairingService,
      credentialService,
      completionRepository,
      initial,
    } = await createFixture();
    const crashRepository = new FailFirstFinishRepository(completionRepository);
    const crashingService = new PairingCredentialCompletionService({
      pairingService,
      credentialService,
      deviceRepository,
      completionRepository: crashRepository,
    });

    await expect(
      crashingService.resumeClaimedPairing(PAIRING_SESSION_ID, "owner-a"),
    ).rejects.toThrow("simulated crash after credential rotation");

    await expect(
      completionRepository.get(PAIRING_SESSION_ID),
    ).resolves.toMatchObject({
      state: "recovering",
      credentialId: initial.credential.credentialId,
      credentialVersion: 1,
    });
    await expect(
      crashingService.acknowledgeDelivery({
        pairingSessionId: PAIRING_SESSION_ID,
        ownerId: "owner-a",
        credentialId: initial.credential.credentialId,
        credentialVersion: initial.credential.version,
      }),
    ).rejects.toMatchObject({ code: "PAIRING_COMPLETION_UNAVAILABLE" });

    const activeAfterCrash = await credentialService.getActive(DEVICE_ID);
    expect(activeAfterCrash).toMatchObject({
      credentialId: CREDENTIAL_IDS[1],
      version: 2,
    });

    const restarted = new PairingCredentialCompletionService({
      pairingService,
      credentialService,
      deviceRepository,
      completionRepository,
    });
    const recovered = await restarted.resumeClaimedPairing(
      PAIRING_SESSION_ID,
      "owner-a",
    );

    expect(recovered.credential).toMatchObject({
      credentialId: CREDENTIAL_IDS[2],
      version: 3,
    });
    expect(recovered.secret).toBe(SECRETS[2]);
    await expect(
      credentialService.verify(DEVICE_ID, SECRETS[1]),
    ).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    await expect(
      credentialService.verify(DEVICE_ID, recovered.secret),
    ).resolves.toMatchObject({ credential: recovered.credential });
    await expect(
      completionRepository.get(PAIRING_SESSION_ID),
    ).resolves.toMatchObject({
      state: "pending",
      credentialId: CREDENTIAL_IDS[2],
      credentialVersion: 3,
    });

    const ack = {
      pairingSessionId: PAIRING_SESSION_ID,
      ownerId: "owner-a",
      credentialId: recovered.credential.credentialId,
      credentialVersion: recovered.credential.version,
    } as const;
    await expect(restarted.acknowledgeDelivery(ack)).resolves.toBeUndefined();
    await expect(restarted.acknowledgeDelivery(ack)).resolves.toBeUndefined();
    await expect(
      completionRepository.get(PAIRING_SESSION_ID),
    ).resolves.toMatchObject({
      state: "delivered",
      credentialId: CREDENTIAL_IDS[2],
      credentialVersion: 3,
    });
  });
});
