import { afterEach, describe, expect, test } from "bun:test";
import { BridgeServerTransport } from "../../agent/src/bridge-server-transport";
import type { BridgeGatewaySession } from "./gateway";
import {
  createDoctmcpServerRuntime,
  type DoctmcpServerRuntime,
} from "./server-runtime";

function waitFor<T>(value: () => T | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for test condition")),
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

describe("DoctmcpServerRuntime", () => {
  const runtimes: DoctmcpServerRuntime[] = [];
  const transports: BridgeServerTransport[] = [];

  afterEach(async () => {
    await Promise.allSettled(
      transports.splice(0).map((transport) => transport.close()),
    );
    await Promise.allSettled(
      runtimes.splice(0).map((runtime) => runtime.stop()),
    );
  });

  async function createPairedRuntime() {
    let readySession: BridgeGatewaySession | undefined;
    const runtime = createDoctmcpServerRuntime({
      port: 0,
      idleTimeoutMs: 0,
      onSession: (session) => {
        readySession = session;
      },
    });
    runtimes.push(runtime);

    const pairing = await runtime.pairingService.createPairingSession({
      localCorrelationId: "runtime-local-channel",
    });
    const completed =
      await runtime.pairingCredentialCompletionService.claimAndIssue(
        pairing.pairingCode,
        {
          ownerId: "owner-runtime",
          deviceName: "Runtime device",
          metadata: { platform: "darwin-arm64" },
        },
      );

    return { runtime, completed, getReadySession: () => readySession };
  }

  test("composition root wires real credential verifier into the production gateway path", async () => {
    const { runtime, completed, getReadySession } = await createPairedRuntime();
    const transport = new BridgeServerTransport({
      url: runtime.gateway.url,
      auth: {
        deviceId: completed.device.deviceId,
        credential: completed.secret,
      },
    });
    transports.push(transport);

    await transport.start();
    const session = await waitFor(getReadySession);

    expect(session.state).toBe("ready");
    expect(session.identity).toEqual({
      ownerId: "owner-runtime",
      deviceId: completed.device.deviceId,
    });
    expect(runtime.gateway.sessionCount).toBe(1);
  });

  test("revoke closes active authenticated session and old credential cannot reconnect", async () => {
    const { runtime, completed } = await createPairedRuntime();
    const transport = new BridgeServerTransport({
      url: runtime.gateway.url,
      auth: {
        deviceId: completed.device.deviceId,
        credential: completed.secret,
      },
    });
    transports.push(transport);
    await transport.start();

    await runtime.revokeDeviceCredential(completed.device.deviceId);
    await waitFor(() => (transport.state === "closed" ? true : undefined));
    expect(runtime.gateway.sessionCount).toBe(0);

    const reconnect = new BridgeServerTransport({
      url: runtime.gateway.url,
      auth: {
        deviceId: completed.device.deviceId,
        credential: completed.secret,
      },
    });
    transports.push(reconnect);
    await expect(reconnect.start()).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
  });

  test("rotate closes old session, rejects old secret and accepts the new generation", async () => {
    const { runtime, completed } = await createPairedRuntime();
    const oldTransport = new BridgeServerTransport({
      url: runtime.gateway.url,
      auth: {
        deviceId: completed.device.deviceId,
        credential: completed.secret,
      },
    });
    transports.push(oldTransport);
    await oldTransport.start();

    const rotated = await runtime.rotateDeviceCredential(
      completed.device.deviceId,
    );
    await waitFor(() => (oldTransport.state === "closed" ? true : undefined));

    const staleReconnect = new BridgeServerTransport({
      url: runtime.gateway.url,
      auth: {
        deviceId: completed.device.deviceId,
        credential: completed.secret,
      },
    });
    transports.push(staleReconnect);
    await expect(staleReconnect.start()).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });

    const currentReconnect = new BridgeServerTransport({
      url: runtime.gateway.url,
      auth: {
        deviceId: completed.device.deviceId,
        credential: rotated.secret,
      },
    });
    transports.push(currentReconnect);
    await currentReconnect.start();
    expect(currentReconnect.state).toBe("ready");
  });
});
