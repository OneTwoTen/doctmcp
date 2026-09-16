import { describe, expect, test } from "bun:test";
import {
  DEVICE_CREDENTIAL_ENTROPY_BITS,
  DeviceCredentialService,
  InMemoryDeviceCredentialRepository,
} from "./device-credential";
import { InMemoryDeviceRepository } from "./device-repository";

const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREDENTIAL_A = "11111111-1111-4111-8111-111111111111";
const CREDENTIAL_B = "22222222-2222-4222-8222-222222222222";
const CREDENTIAL_C = "33333333-3333-4333-8333-333333333333";

async function createDevice(
  repository: InMemoryDeviceRepository,
  ownerId: string,
) {
  return repository.create({
    ownerId,
    deviceName: `device-${ownerId}`,
    metadata: { platform: "darwin-arm64" },
  });
}

describe("DeviceCredentialService", () => {
  test("issue/verify bind đúng device + owner và raw secret không nằm trong snapshot", async () => {
    const devices = new InMemoryDeviceRepository({
      generateDeviceId: () => DEVICE_A,
    });
    await createDevice(devices, "owner-a");
    const repository = new InMemoryDeviceCredentialRepository();
    const service = new DeviceCredentialService({
      repository,
      deviceRepository: devices,
      generateCredentialId: () => CREDENTIAL_A,
      generateSecret: () => "secret-a",
    });

    const issued = await service.issue(DEVICE_A);
    expect(DEVICE_CREDENTIAL_ENTROPY_BITS).toBe(256);
    expect(issued.credential.deviceId).toBe(DEVICE_A);
    expect(issued.secret).toBe("secret-a");
    expect(JSON.stringify(issued.credential)).not.toContain("secret-a");

    const verified = await service.verify(DEVICE_A, "secret-a");
    expect(verified.identity).toEqual({
      ownerId: "owner-a",
      deviceId: DEVICE_A,
    });
    expect(verified.credential.credentialId).toBe(CREDENTIAL_A);
  });

  test("wrong/mismatched credential reject generic", async () => {
    let nextId = DEVICE_A;
    const devices = new InMemoryDeviceRepository({
      generateDeviceId: () => nextId,
    });
    await createDevice(devices, "owner-a");
    nextId = DEVICE_B;
    await createDevice(devices, "owner-b");

    const repository = new InMemoryDeviceCredentialRepository();
    const service = new DeviceCredentialService({
      repository,
      deviceRepository: devices,
      generateCredentialId: () => CREDENTIAL_A,
      generateSecret: () => "secret-a",
    });
    await service.issue(DEVICE_A);

    for (const [deviceId, secret] of [
      [DEVICE_A, "wrong"],
      [DEVICE_B, "secret-a"],
      ["not-a-device", "secret-a"],
    ] as const) {
      await expect(service.verify(deviceId, secret)).rejects.toMatchObject({
        code: "CREDENTIAL_UNAVAILABLE",
        message: "Device credential không khả dụng.",
      });
    }
  });

  test("revoke invalidates credential", async () => {
    const devices = new InMemoryDeviceRepository({
      generateDeviceId: () => DEVICE_A,
    });
    await createDevice(devices, "owner-a");
    const repository = new InMemoryDeviceCredentialRepository();
    const service = new DeviceCredentialService({
      repository,
      deviceRepository: devices,
      generateCredentialId: () => CREDENTIAL_A,
      generateSecret: () => "secret-a",
    });
    await service.issue(DEVICE_A);
    const revoked = await service.revoke(DEVICE_A);
    expect(revoked.state).toBe("revoked");
    await expect(service.verify(DEVICE_A, "secret-a")).rejects.toMatchObject({
      code: "CREDENTIAL_UNAVAILABLE",
    });
  });

  test("rotate atomically makes old secret fail and new secret work", async () => {
    const ids = [CREDENTIAL_A, CREDENTIAL_B];
    const secrets = ["secret-a", "secret-b"];
    const devices = new InMemoryDeviceRepository({
      generateDeviceId: () => DEVICE_A,
    });
    await createDevice(devices, "owner-a");
    const repository = new InMemoryDeviceCredentialRepository();
    const service = new DeviceCredentialService({
      repository,
      deviceRepository: devices,
      generateCredentialId: () => ids.shift() ?? CREDENTIAL_B,
      generateSecret: () => secrets.shift() ?? "secret-b",
    });
    const first = await service.issue(DEVICE_A);
    const rotated = await service.rotate(DEVICE_A);

    expect(first.credential.version).toBe(1);
    expect(rotated.credential.version).toBe(2);
    await expect(service.verify(DEVICE_A, first.secret)).rejects.toMatchObject({
      code: "CREDENTIAL_UNAVAILABLE",
    });
    await expect(
      service.verify(DEVICE_A, rotated.secret),
    ).resolves.toMatchObject({
      identity: { ownerId: "owner-a", deviceId: DEVICE_A },
    });
  });

  test("concurrent rotate/revoke dùng CAS: chỉ một mutation thắng", async () => {
    const devices = new InMemoryDeviceRepository({
      generateDeviceId: () => DEVICE_A,
    });
    await createDevice(devices, "owner-a");
    const repository = new InMemoryDeviceCredentialRepository();
    const service = new DeviceCredentialService({
      repository,
      deviceRepository: devices,
      generateCredentialId: (() => {
        const ids = [CREDENTIAL_A, CREDENTIAL_B];
        return () => ids.shift() ?? CREDENTIAL_B;
      })(),
      generateSecret: (() => {
        const values = ["secret-a", "secret-b"];
        return () => values.shift() ?? "secret-b";
      })(),
    });
    await service.issue(DEVICE_A);

    const results = await Promise.allSettled([
      service.rotate(DEVICE_A),
      service.revoke(DEVICE_A),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });

  test("concurrent rotate/rotate dùng CAS: chỉ một secret mới được commit", async () => {
    const devices = new InMemoryDeviceRepository({
      generateDeviceId: () => DEVICE_A,
    });
    await createDevice(devices, "owner-a");
    const repository = new InMemoryDeviceCredentialRepository();
    const ids = [CREDENTIAL_A, CREDENTIAL_B, CREDENTIAL_C];
    const secrets = ["secret-a", "secret-b", "secret-c"];
    const service = new DeviceCredentialService({
      repository,
      deviceRepository: devices,
      generateCredentialId: () => ids.shift() ?? CREDENTIAL_C,
      generateSecret: () => secrets.shift() ?? "secret-c",
    });
    await service.issue(DEVICE_A);

    const results = await Promise.allSettled([
      service.rotate(DEVICE_A),
      service.rotate(DEVICE_A),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    if (fulfilled[0]?.status !== "fulfilled") throw new Error("missing winner");
    await expect(
      service.verify(DEVICE_A, fulfilled[0].value.secret),
    ).resolves.toMatchObject({
      credential: { version: 2 },
    });
  });

  test("credentialId không được reuse giữa device hoặc generation", async () => {
    let nextDeviceId = DEVICE_A;
    const devices = new InMemoryDeviceRepository({
      generateDeviceId: () => nextDeviceId,
    });
    await createDevice(devices, "owner-a");
    nextDeviceId = DEVICE_B;
    await createDevice(devices, "owner-b");

    const repository = new InMemoryDeviceCredentialRepository();
    const serviceA = new DeviceCredentialService({
      repository,
      deviceRepository: devices,
      generateCredentialId: () => CREDENTIAL_A,
      generateSecret: () => "secret-a",
    });
    await serviceA.issue(DEVICE_A);

    const serviceB = new DeviceCredentialService({
      repository,
      deviceRepository: devices,
      generateCredentialId: () => CREDENTIAL_A,
      generateSecret: () => "secret-b",
    });
    await expect(serviceB.issue(DEVICE_B)).rejects.toMatchObject({
      code: "CREDENTIAL_ID_CONFLICT",
    });
  });
});
