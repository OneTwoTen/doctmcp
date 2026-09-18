import { afterEach, describe, expect, test } from "bun:test";
import { BridgeServerTransport } from "../../agent/src/bridge-server-transport";
import { createLocalMcpRuntime } from "../../agent/src/local-mcp-runtime";
import type { LocalMcpServerInstance } from "../../agent/src/server";
import { WorkspaceRegistry } from "../../agent/src/workspace";
import {
  createDoctmcpServerRuntime,
  type DoctmcpServerRuntime,
} from "./server-runtime";

function waitFor<T>(value: () => T | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for authenticated device")),
      2_000,
    );
    const check = (): void => {
      const result = value();
      if (result === undefined) {
        setTimeout(check, 1);
        return;
      }
      clearTimeout(timeout);
      resolve(result);
    };
    check();
  });
}

describe("DoctmcpServerRuntime device routing", () => {
  const runtimes: DoctmcpServerRuntime[] = [];
  const localRuntimes: LocalMcpServerInstance[] = [];
  const transports: BridgeServerTransport[] = [];

  afterEach(async () => {
    await Promise.allSettled(
      localRuntimes.splice(0).map((runtime) => runtime.close()),
    );
    await Promise.allSettled(
      transports.splice(0).map((transport) => transport.close()),
    );
    await Promise.allSettled(
      runtimes.splice(0).map((runtime) => runtime.stop()),
    );
  });

  async function pairDevice(runtime: DoctmcpServerRuntime, deviceName: string) {
    const pairing = await runtime.pairingService.createPairingSession({
      localCorrelationId: crypto.randomUUID(),
    });
    return runtime.pairingCredentialCompletionService.claimAndIssue(
      pairing.pairingCode,
      {
        ownerId: "owner-routing",
        deviceName,
        metadata: { platform: "test" },
      },
    );
  }

  async function connectLocal(
    runtime: DoctmcpServerRuntime,
    input: { readonly deviceId: string; readonly secret: string },
  ) {
    const localRuntime = createLocalMcpRuntime(
      await WorkspaceRegistry.create([]),
    );
    localRuntimes.push(localRuntime);
    const transport = new BridgeServerTransport({
      url: runtime.gateway.url,
      auth: { deviceId: input.deviceId, credential: input.secret },
    });
    transports.push(transport);
    const connected = localRuntime.connect(transport);
    await waitFor(
      () =>
        runtime.deviceSessionRegistry.getActive(input.deviceId) ?? undefined,
    );
    await connected;
  }

  test("routes to exact authenticated device and does not route after credential revoke", async () => {
    const runtime = createDoctmcpServerRuntime({ port: 0, idleTimeoutMs: 0 });
    runtimes.push(runtime);
    const deviceA = await pairDevice(runtime, "Same display name");
    const deviceB = await pairDevice(runtime, "Same display name");

    await connectLocal(runtime, {
      deviceId: deviceA.device.deviceId,
      secret: deviceA.secret,
    });
    await connectLocal(runtime, {
      deviceId: deviceB.device.deviceId,
      secret: deviceB.secret,
    });

    const devices = await runtime.deviceRouter.listDevices("owner-routing");
    expect(devices.map(({ deviceId }) => deviceId).sort()).toEqual(
      [deviceA.device.deviceId, deviceB.device.deviceId].sort(),
    );
    expect(devices.map(({ status }) => status)).toEqual(["online", "online"]);

    const routeA = await runtime.deviceRouter.resolve(
      "owner-routing",
      deviceA.device.deviceId,
    );
    const routeB = await runtime.deviceRouter.resolve(
      "owner-routing",
      deviceB.device.deviceId,
    );
    expect(routeA.session.identity?.deviceId).toBe(deviceA.device.deviceId);
    expect(routeB.session.identity?.deviceId).toBe(deviceB.device.deviceId);
    expect(routeA.session).not.toBe(routeB.session);

    await routeB.session.close("TIMEOUT", "TEST_DISCONNECT_AFTER_RESOLVE");
    await expect(
      runtime.deviceRouter.resolve("owner-routing", deviceB.device.deviceId),
    ).rejects.toMatchObject({ code: "DEVICE_OFFLINE" });
    await expect(
      runtime.deviceRouter.resolve("owner-routing", deviceA.device.deviceId),
    ).resolves.toMatchObject({ session: routeA.session });

    await runtime.revokeDeviceCredential(deviceA.device.deviceId);
    await expect(
      runtime.deviceRouter.resolve("owner-routing", deviceA.device.deviceId),
    ).rejects.toMatchObject({ code: "DEVICE_CREDENTIAL_UNAVAILABLE" });
    await expect(
      runtime.deviceRouter.resolve("another-owner", deviceB.device.deviceId),
    ).rejects.toMatchObject({ code: "DEVICE_NOT_FOUND" });
  });
});
