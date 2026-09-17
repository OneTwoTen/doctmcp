import { afterEach, describe, expect, test } from "bun:test";
import { InMemoryDeviceCredentialProvider } from "../../agent/src/device-credential-provider";
import { LocalBridgeReconnectController } from "../../agent/src/local-bridge-reconnect";
import { createLocalMcpRuntime } from "../../agent/src/local-mcp-runtime";
import { WorkspaceRegistry } from "../../agent/src/workspace";
import {
  createDoctmcpServerRuntime,
  type DoctmcpServerRuntime,
} from "./server-runtime";

function waitFor<T>(value: () => T | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for M3 reconnect condition")),
      3_000,
    );
    const check = (): void => {
      const result = value();
      if (result === undefined) {
        setTimeout(check, 5);
        return;
      }
      clearTimeout(timeout);
      resolve(result);
    };
    check();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("M3.5 authenticated local reconnect acceptance", () => {
  const serverRuntimes: DoctmcpServerRuntime[] = [];
  const localRuntimes: Array<ReturnType<typeof createLocalMcpRuntime>> = [];
  const controllers: LocalBridgeReconnectController[] = [];

  afterEach(async () => {
    await Promise.allSettled(
      controllers.splice(0).map((controller) => controller.stop()),
    );
    await Promise.allSettled(
      localRuntimes.splice(0).map((runtime) => runtime.close()),
    );
    await Promise.allSettled(
      serverRuntimes.splice(0).map((runtime) => runtime.stop()),
    );
  });

  async function setup() {
    const serverRuntime = createDoctmcpServerRuntime({
      port: 0,
      idleTimeoutMs: 0,
      heartbeatIntervalMs: 20,
      heartbeatTimeoutMs: 200,
    });
    serverRuntimes.push(serverRuntime);

    const pairing = await serverRuntime.pairingService.createPairingSession({
      localCorrelationId: crypto.randomUUID(),
    });
    const completed =
      await serverRuntime.pairingCredentialCompletionService.claimAndIssue(
        pairing.pairingCode,
        {
          ownerId: "owner-m3-5",
          deviceName: "M3.5 reconnect device",
          metadata: { platform: "test" },
        },
      );

    const credentialProvider = new InMemoryDeviceCredentialProvider({
      deviceId: completed.device.deviceId,
      credential: completed.secret,
    });
    const workspaceRegistry = await WorkspaceRegistry.create([]);
    const localRuntime = createLocalMcpRuntime(workspaceRegistry);
    localRuntimes.push(localRuntime);

    const controller = new LocalBridgeReconnectController({
      url: serverRuntime.gateway.url,
      runtime: localRuntime,
      credentialProvider,
      random: () => 0.5,
      backoffPolicy: {
        minDelayMs: 10,
        maxDelayMs: 20,
        factor: 2,
        jitterRatio: 0,
        stableReadyMs: 100,
      },
    });
    controllers.push(controller);

    return { serverRuntime, completed, credentialProvider, controller };
  }

  test("transient timeout reconnects with the same device credential and restores online session", async () => {
    const { serverRuntime, completed, credentialProvider, controller } =
      await setup();

    controller.start();
    const first = await waitFor(() => {
      if (controller.snapshot.state !== "ready") return undefined;
      return (
        serverRuntime.deviceSessionRegistry.getActive(completed.device.deviceId) ??
        undefined
      );
    });
    expect(serverRuntime.getDeviceStatus(completed.device.deviceId).status).toBe(
      "online",
    );

    await first.session.close("TIMEOUT", "TEST_HEARTBEAT_TIMEOUT");

    const second = await waitFor(() => {
      if (controller.snapshot.state !== "ready") return undefined;
      const active = serverRuntime.deviceSessionRegistry.getActive(
        completed.device.deviceId,
      );
      return active && active.session.id !== first.session.id
        ? active
        : undefined;
    });

    expect(second.session.id).not.toBe(first.session.id);
    expect(controller.snapshot.attemptGeneration).toBeGreaterThanOrEqual(2);
    expect(serverRuntime.getDeviceStatus(completed.device.deviceId).status).toBe(
      "online",
    );
    expect(await credentialProvider.load()).toEqual({
      deviceId: completed.device.deviceId,
      credential: completed.secret,
    });
  });

  test("revoked credential stops reconnect loop in auth-failed state", async () => {
    const { serverRuntime, completed, controller } = await setup();

    controller.start();
    await waitFor(() =>
      controller.snapshot.state === "ready" &&
      serverRuntime.getDeviceStatus(completed.device.deviceId).status === "online"
        ? true
        : undefined,
    );

    await serverRuntime.revokeDeviceCredential(completed.device.deviceId);
    await waitFor(() =>
      controller.snapshot.state === "auth-failed" ? true : undefined,
    );

    const terminalAttempt = controller.snapshot.attemptGeneration;
    expect(controller.snapshot.lastFailureCode).toBe("AUTH_FAILED");
    expect(serverRuntime.getDeviceStatus(completed.device.deviceId).status).toBe(
      "offline",
    );

    await delay(80);
    expect(controller.snapshot.state).toBe("auth-failed");
    expect(controller.snapshot.attemptGeneration).toBe(terminalAttempt);
  });
});
