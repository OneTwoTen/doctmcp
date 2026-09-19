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
  toPairingCredentialDelivery,
} from "./pairing-credential-completion";

const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAIRING_SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";
const RECOVERED_CREDENTIAL_ID = "22222222-2222-4222-8222-222222222222";
const RAW_CREDENTIAL = "issued-only-once-secret";
const RECOVERED_RAW_CREDENTIAL = "recovered-after-restart-secret";

async function createFixture(
  options: {
    failFirstIssue?: boolean;
    completionRepository?: InMemoryPairingCredentialCompletionRepository;
  } = {},
) {
  let now = new Date("2026-09-15T08:00:00.000Z");
  let secretAttempts = 0;
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
    generateSecret: () => {
      secretAttempts += 1;
      if (options.failFirstIssue && secretAttempts === 1) {
        throw new Error("simulated credential generator failure");
      }
      return RAW_CREDENTIAL;
    },
  });
  const completionService = new PairingCredentialCompletionService({
    pairingService,
    credentialService,
    deviceRepository: devices,
    ...(options.completionRepository
      ? { completionRepository: options.completionRepository }
      : {}),
  });

  const created = await pairingService.createPairingSession({
    localCorrelationId: "local-pairing-channel-1",
  });
  now = new Date("2026-09-15T08:01:00.000Z");

  return {
    created,
    devices,
    credentialRepository,
    credentialService,
    completionService,
    pairingService,
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

  test("resume cùng claimed session trả đúng pending delivery, không issue generation thứ hai", async () => {
    const { created, credentialRepository, completionService } =
      await createFixture();
    const completed = await completionService.claimAndIssue(
      created.pairingCode,
      {
        ownerId: "owner-a",
        deviceName: "DoCT Mac",
        metadata: { platform: "darwin-arm64" },
      },
    );

    const resumed = await completionService.resumeClaimedPairing(
      PAIRING_SESSION_ID,
      "owner-a",
    );

    expect(resumed).toBe(completed);
    expect(resumed.secret).toBe(RAW_CREDENTIAL);
    await expect(
      credentialRepository.getActive(DEVICE_ID),
    ).resolves.toMatchObject({
      credentialId: CREDENTIAL_ID,
      version: 1,
    });
  });

  test("cached pending delivery vẫn kiểm tra owner trước khi trả raw credential", async () => {
    const { created, completionService } = await createFixture();
    await completionService.claimAndIssue(created.pairingCode, {
      ownerId: "owner-a",
      deviceName: "DoCT Mac",
      metadata: { platform: "darwin-arm64" },
    });

    await expect(
      completionService.resumeClaimedPairing(PAIRING_SESSION_ID, "owner-b"),
    ).rejects.toMatchObject({
      code: "PAIRING_COMPLETION_UNAVAILABLE",
    });
  });

  test("credential issue fail sau claim vẫn recover được bằng pairingSessionId", async () => {
    const { created, credentialRepository, completionService, pairingService } =
      await createFixture({ failFirstIssue: true });

    await expect(
      completionService.claimAndIssue(created.pairingCode, {
        ownerId: "owner-a",
        deviceName: "DoCT Mac",
        metadata: { platform: "darwin-arm64" },
      }),
    ).rejects.toThrow("simulated credential generator failure");

    await expect(
      pairingService.getPairingSession(PAIRING_SESSION_ID),
    ).resolves.toMatchObject({
      state: "claimed",
      deviceId: DEVICE_ID,
    });
    await expect(credentialRepository.getActive(DEVICE_ID)).resolves.toBeNull();

    const recovered = await completionService.resumeClaimedPairing(
      PAIRING_SESSION_ID,
      "owner-a",
    );
    expect(recovered.secret).toBe(RAW_CREDENTIAL);
    expect(recovered.credential).toMatchObject({
      credentialId: CREDENTIAL_ID,
      version: 1,
      deviceId: DEVICE_ID,
    });
  });

  test("restart sau persist-before-delivery rotate credential thất lạc và trả secret mới", async () => {
    const {
      created,
      devices,
      credentialRepository,
      credentialService,
      completionService,
      pairingService,
    } = await createFixture();
    await completionService.claimAndIssue(created.pairingCode, {
      ownerId: "owner-a",
      deviceName: "DoCT Mac",
      metadata: { platform: "darwin-arm64" },
    });

    const restartedCredentialService = new DeviceCredentialService({
      repository: credentialRepository,
      deviceRepository: devices,
      generateCredentialId: () => RECOVERED_CREDENTIAL_ID,
      generateSecret: () => RECOVERED_RAW_CREDENTIAL,
    });
    const restartedCompletionService = new PairingCredentialCompletionService({
      pairingService,
      credentialService: restartedCredentialService,
      deviceRepository: devices,
    });

    const recovered = await restartedCompletionService.resumeClaimedPairing(
      PAIRING_SESSION_ID,
      "owner-a",
    );

    expect(recovered.secret).toBe(RECOVERED_RAW_CREDENTIAL);
    expect(recovered.credential).toMatchObject({
      credentialId: RECOVERED_CREDENTIAL_ID,
      deviceId: DEVICE_ID,
      version: 2,
      state: "active",
    });
    await expect(
      credentialService.verify(DEVICE_ID, RAW_CREDENTIAL),
    ).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    await expect(
      restartedCredentialService.verify(DEVICE_ID, RECOVERED_RAW_CREDENTIAL),
    ).resolves.toMatchObject({
      credential: { version: 2 },
      identity: { ownerId: "owner-a", deviceId: DEVICE_ID },
    });
  });

  test("resume claimed session không tin owner do caller tự khai báo", async () => {
    const { created, completionService } = await createFixture({
      failFirstIssue: true,
    });
    await expect(
      completionService.claimAndIssue(created.pairingCode, {
        ownerId: "owner-a",
        deviceName: "DoCT Mac",
        metadata: { platform: "darwin-arm64" },
      }),
    ).rejects.toBeDefined();

    await expect(
      completionService.resumeClaimedPairing(PAIRING_SESSION_ID, "owner-b"),
    ).rejects.toMatchObject({
      code: "PAIRING_COMPLETION_UNAVAILABLE",
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
  test("completion capacity is admitted before credential issue and remains recoverable", async () => {
    const completionRepository =
      new InMemoryPairingCredentialCompletionRepository({ maxRecords: 1 });
    const occupiedSessionId = "99999999-9999-4999-8999-999999999999";
    await completionRepository.setPending({
      pairingSessionId: occupiedSessionId,
      deviceId: "88888888-8888-4888-8888-888888888888",
      credentialId: "77777777-7777-4777-8777-777777777777",
      credentialVersion: 1,
    });
    const fixture = await createFixture({ completionRepository });

    await expect(
      fixture.completionService.claimAndIssue(fixture.created.pairingCode, {
        ownerId: "owner-a",
        deviceName: "Capacity device",
        metadata: { platform: "linux-x64" },
      }),
    ).rejects.toMatchObject({ code: "PAIRING_COMPLETION_UNAVAILABLE" });
    await expect(
      fixture.credentialRepository.getActive(DEVICE_ID),
    ).resolves.toBeNull();
    await expect(
      fixture.pairingService.getPairingSession(PAIRING_SESSION_ID),
    ).resolves.toMatchObject({ state: "claimed", deviceId: DEVICE_ID });

    await completionRepository.delete(occupiedSessionId);
    const resumed = await fixture.completionService.resumeClaimedPairing(
      PAIRING_SESSION_ID,
      "owner-a",
    );
    expect(resumed.credential).toMatchObject({
      deviceId: DEVICE_ID,
      state: "active",
    });
  });

});
