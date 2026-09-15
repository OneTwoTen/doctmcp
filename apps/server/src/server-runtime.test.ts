import { afterEach, describe, expect, test } from "bun:test";
import { BridgeServerTransport } from "../../agent/src/bridge-server-transport";
import { InMemoryDeviceCredentialRepository } from "./device-credential";
import type { BridgeGatewaySession } from "./gateway";
import {
  createDoctmcpServerRuntime,
  type DoctmcpServerRuntime,
} from "./server-runtime";

class BlockingVerifyCredentialRepository extends InMemoryDeviceCredentialRepository {
  #armed = false;
  #verifyStarted: Promise<void> = Promise.resolve();
  #resolveVerifyStarted: (() => void) | undefined;
  #releaseVerify: Promise<void> = Promise.resolve();
  #resolveReleaseVerify: (() => void) | undefined;

  armNextVerify(): void {
    this.#armed = true;
    this.#verifyStarted = new Promise((resolve) => {
      this.#resolveVerifyStarted = resolve;
    });
    this.#releaseVerify = new Promise((resolve) => {
      this.#resolveReleaseVerify = resolve;
    });
  }

  waitUntilVerifyBlocked(): Promise<void> {
    return this.#verifyStarted;
  }

  releaseVerify(): void {
    this.#resolveReleaseVerify?.();
  }

  override async verify(deviceId: string, secretDigest: string) {
    const result = await super.verify(deviceId, secretDigest);
    if (!this.#armed) return result;

    this.#armed = false;
    this.#resolveVerifyStarted?.();
    await this.#releaseVerify;
    return result;
  }
}

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

  async function createPairedRuntime(options: {
    credentialRepository?: InMemoryDeviceCredentialRepository;
  } = {}) {
    let readySession: BridgeGatewaySession | undefined;
    const runtime = createDoctmcpServerRuntime({
      port: 0,
      idleTimeoutMs: 0,
      ...(options.credentialRepository
        ? { credentialRepository: options.credentialRepository }
        : {}),
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

  test("runtime không expose credential service/repository mutation để bypass invalidation", async () => {
    const { runtime } = await createPairedRuntime();

    expect("credentialService" in runtime).toBe(false);
    expect("credentialRepository" in runtime).toBe(false);
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

  test("revoke thắng handshake đã verify snapshot cũ nhưng chưa được expose ready", async () => {
    const repository = new BlockingVerifyCredentialRepository();
    const { runtime, completed, getReadySession } = await createPairedRuntime({
      credentialRepository: repository,
    });
    repository.armNextVerify();

    const transport = new BridgeServerTransport({
      url: runtime.gateway.url,
      auth: {
        deviceId: completed.device.deviceId,
        credential: completed.secret,
      },
    });
    transports.push(transport);
    const startPromise = transport.start();
    await repository.waitUntilVerifyBlocked();

    const revokePromise = runtime.revokeDeviceCredential(
      completed.device.deviceId,
    );
    repository.releaseVerify();

    await expect(startPromise).rejects.toMatchObject({ code: "AUTH_FAILED" });
    await revokePromise;
    expect(getReadySession()).toBeUndefined();
    expect(runtime.gateway.sessionCount).toBe(0);
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
