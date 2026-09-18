import { describe, expect, test } from "bun:test";
import type { BridgeMessage } from "@doctmcp/protocol";
import {
  DeviceCredentialService,
  InMemoryDeviceCredentialRepository,
} from "./device-credential";
import { InMemoryDeviceRepository } from "./device-repository";
import { DeviceRoutingError, DeviceRoutingService } from "./device-routing";
import { DeviceSessionRegistry } from "./device-session-registry";
import type { BridgeGatewaySession } from "./gateway";

const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DEVICE_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const UNKNOWN_DEVICE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function createSession(input: {
  readonly id: string;
  readonly ownerId: string;
  readonly deviceId: string;
}): BridgeGatewaySession {
  let state: BridgeGatewaySession["state"] = "ready";
  const session: BridgeGatewaySession = {
    id: input.id,
    get state() {
      return state;
    },
    identity: { ownerId: input.ownerId, deviceId: input.deviceId },
    onmessage: undefined,
    onclose: undefined,
    async send(_message: BridgeMessage) {},
    async close(code = "NORMAL") {
      if (state === "closed") return;
      state = "closed";
      session.onclose?.(code);
    },
  };
  return session;
}

function createHarness() {
  const deviceIds = [DEVICE_A, DEVICE_B, DEVICE_C];
  const deviceRepository = new InMemoryDeviceRepository({
    generateDeviceId() {
      const next = deviceIds.shift();
      if (!next) throw new Error("No test device ids remain");
      return next;
    },
  });
  let credentialSequence = 0;
  const credentialRepository = new InMemoryDeviceCredentialRepository();
  const credentialService = new DeviceCredentialService({
    repository: credentialRepository,
    deviceRepository,
    generateCredentialId: () =>
      `11111111-1111-4111-8111-${String(++credentialSequence).padStart(12, "0")}`,
    generateSecret: () => "A".repeat(43),
  });
  const deviceSessionRegistry = new DeviceSessionRegistry();
  const deviceRouter = new DeviceRoutingService({
    deviceRepository,
    credentialRepository,
    deviceSessionRegistry,
  });

  return {
    deviceRepository,
    credentialRepository,
    credentialService,
    deviceSessionRegistry,
    deviceRouter,
    async createDevice(ownerId: string, deviceName = "Shared name") {
      const device = await deviceRepository.create({
        ownerId,
        deviceName,
        metadata: { platform: "win32-x64" },
      });
      const issued = await credentialService.issue(device.deviceId);
      return { device, issued };
    },
    registerSession(
      device: { readonly deviceId: string; readonly ownerId: string },
      credential: { readonly credentialId: string; readonly version: number },
      id: string,
    ) {
      const session = createSession({
        id,
        ownerId: device.ownerId,
        deviceId: device.deviceId,
      });
      deviceSessionRegistry.register(session, {
        credentialId: credential.credentialId,
        credentialVersion: credential.version,
      });
      return session;
    },
  };
}

describe("DeviceRoutingService", () => {
  test("lists only owner devices and returns safe online/offline snapshots", async () => {
    const harness = createHarness();
    const deviceA = await harness.createDevice("owner-a");
    await harness.createDevice("owner-a");
    await harness.createDevice("owner-b");
    harness.registerSession(
      deviceA.device,
      deviceA.issued.credential,
      "session-a",
    );

    const devices = await harness.deviceRouter.listDevices("owner-a");

    expect(devices.map(({ deviceId }) => deviceId)).toEqual([
      DEVICE_A,
      DEVICE_B,
    ]);
    expect(devices.map(({ status }) => status)).toEqual(["online", "offline"]);
    expect(devices[0]?.deviceName).toBe(devices[1]?.deviceName);
    expect("ownerId" in (devices[0] ?? {})).toBe(false);
    expect("session" in (devices[0] ?? {})).toBe(false);
    expect("credentialGeneration" in (devices[0] ?? {})).toBe(false);
    expect(JSON.stringify(devices)).not.toContain(deviceA.issued.secret);
  });

  test("does not reveal whether a device belongs to another owner", async () => {
    const harness = createHarness();
    const otherOwnerDevice = await harness.createDevice("owner-b");

    for (const deviceId of [otherOwnerDevice.device.deviceId, UNKNOWN_DEVICE]) {
      await expect(
        harness.deviceRouter.getDevice("owner-a", deviceId),
      ).rejects.toMatchObject({ code: "DEVICE_NOT_FOUND" });
    }
  });

  test("resolves the requested device id even when names are identical", async () => {
    const harness = createHarness();
    const deviceA = await harness.createDevice("owner-a");
    const deviceB = await harness.createDevice("owner-a");
    const sessionA = harness.registerSession(
      deviceA.device,
      deviceA.issued.credential,
      "session-a",
    );
    const sessionB = harness.registerSession(
      deviceB.device,
      deviceB.issued.credential,
      "session-b",
    );

    const route = await harness.deviceRouter.resolve("owner-a", DEVICE_B);

    expect(route.device.deviceId).toBe(DEVICE_B);
    expect(route.session).toBe(sessionB);
    expect(route.session).not.toBe(sessionA);
  });

  test("renaming metadata does not change the device route", async () => {
    const harness = createHarness();
    const device = await harness.createDevice("owner-a");
    const session = harness.registerSession(
      device.device,
      device.issued.credential,
      "session-a",
    );
    await harness.deviceRepository.updateForOwner("owner-a", DEVICE_A, {
      deviceName: "Renamed workstation",
    });

    const listed = await harness.deviceRouter.getDevice("owner-a", DEVICE_A);
    const route = await harness.deviceRouter.resolve("owner-a", DEVICE_A);

    expect(listed.deviceName).toBe("Renamed workstation");
    expect(route.device.deviceId).toBe(DEVICE_A);
    expect(route.session).toBe(session);
  });

  test("returns DEVICE_OFFLINE when an owned device has no live session", async () => {
    const harness = createHarness();
    await harness.createDevice("owner-a");

    await expect(
      harness.deviceRouter.resolve("owner-a", DEVICE_A),
    ).rejects.toMatchObject({ code: "DEVICE_OFFLINE" });
  });

  test("does not route after credential revoke even before invalidation arrives", async () => {
    const harness = createHarness();
    const device = await harness.createDevice("owner-a");
    harness.registerSession(
      device.device,
      device.issued.credential,
      "session-a",
    );
    await harness.credentialService.revoke(device.device.deviceId);

    await expect(
      harness.deviceRouter.resolve("owner-a", DEVICE_A),
    ).rejects.toMatchObject({ code: "DEVICE_CREDENTIAL_UNAVAILABLE" });
    await expect(
      harness.deviceRouter.listDevices("owner-a"),
    ).resolves.toMatchObject([{ deviceId: DEVICE_A, status: "offline" }]);
  });

  test("uses the replacement session and rejects stale credential generations", async () => {
    const harness = createHarness();
    const device = await harness.createDevice("owner-a");
    const oldSession = harness.registerSession(
      device.device,
      device.issued.credential,
      "session-old",
    );
    const rotated = await harness.credentialService.rotate(DEVICE_A);

    await expect(
      harness.deviceRouter.resolve("owner-a", DEVICE_A),
    ).rejects.toMatchObject({ code: "DEVICE_CREDENTIAL_UNAVAILABLE" });

    const newSession = harness.registerSession(
      device.device,
      rotated.credential,
      "session-new",
    );
    await oldSession.close();

    const route = await harness.deviceRouter.resolve("owner-a", DEVICE_A);
    expect(route.session).toBe(newSession);
    expect(route.session).not.toBe(oldSession);
  });

  test("maps malformed ids to the same owner-safe not-found error", async () => {
    const harness = createHarness();

    await expect(
      harness.deviceRouter.getDevice("owner-a", "not-a-device-id"),
    ).rejects.toBeInstanceOf(DeviceRoutingError);
    await expect(
      harness.deviceRouter.resolve("owner-a", "not-a-device-id"),
    ).rejects.toMatchObject({ code: "DEVICE_NOT_FOUND" });
  });
});
