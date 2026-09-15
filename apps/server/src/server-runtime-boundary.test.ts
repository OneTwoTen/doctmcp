import { describe, expect, test } from "bun:test";
import { BridgeServerTransport } from "../../agent/src/bridge-server-transport";
import { InMemoryDeviceCredentialRepository } from "./device-credential";
import type { BridgeGatewaySession } from "./gateway";
import { createDoctmcpServerRuntime } from "./server-runtime";

class FailSecondVerifyCredentialRepository extends InMemoryDeviceCredentialRepository {
  #verifyCount = 0;

  override async verify(deviceId: string, secretDigest: string) {
    this.#verifyCount += 1;
    if (this.#verifyCount === 2) return null;
    return super.verify(deviceId, secretDigest);
  }
}

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

async function createPairedRuntime(
  credentialRepository: InMemoryDeviceCredentialRepository,
  onSession?: (session: BridgeGatewaySession) => void,
) {
  const runtime = createDoctmcpServerRuntime({
    port: 0,
    idleTimeoutMs: 0,
    credentialRepository,
    ...(onSession ? { onSession } : {}),
  });
  const pairing = await runtime.pairingService.createPairingSession({
    localCorrelationId: "boundary-channel",
  });
  const completed =
    await runtime.pairingCredentialCompletionService.claimAndIssue(
      pairing.pairingCode,
      {
        ownerId: "owner-boundary",
        deviceName: "Boundary device",
        metadata: { platform: "darwin-arm64" },
      },
    );
  return { runtime, completed };
}

describe("DoctmcpServerRuntime security boundaries", () => {
  test("credential thay đổi giữa auth và ready revalidation bị reject trước ACK/session", async () => {
    const repository = new FailSecondVerifyCredentialRepository();
    let readySession: BridgeGatewaySession | undefined;
    const { runtime, completed } = await createPairedRuntime(
      repository,
      (session) => {
        readySession = session;
      },
    );
    const transport = new BridgeServerTransport({
      url: runtime.gateway.url,
      auth: {
        deviceId: completed.device.deviceId,
        credential: completed.secret,
      },
    });

    try {
      await expect(transport.start()).rejects.toMatchObject({
        code: "AUTH_FAILED",
      });
      expect(transport.state).not.toBe("ready");
      expect(readySession).toBeUndefined();
      expect(runtime.gateway.sessionCount).toBe(0);
    } finally {
      await Promise.allSettled([transport.close(), runtime.stop()]);
    }
  });

  test("stop resolve drain waiter để revoke đang chờ auth không treo vô hạn", async () => {
    const repository = new BlockingVerifyCredentialRepository();
    const { runtime, completed } = await createPairedRuntime(repository);
    repository.armNextVerify();

    const transport = new BridgeServerTransport({
      url: runtime.gateway.url,
      auth: {
        deviceId: completed.device.deviceId,
        credential: completed.secret,
      },
    });
    const startPromise = transport.start();
    await repository.waitUntilVerifyBlocked();

    const revokePromise = runtime.revokeDeviceCredential(
      completed.device.deviceId,
    );
    const stopPromise = runtime.stop();

    const revokeSettled = await Promise.race([
      revokePromise.then(
        () => true,
        () => true,
      ),
      Bun.sleep(500).then(() => false),
    ]);
    expect(revokeSettled).toBe(true);

    repository.releaseVerify();
    await Promise.allSettled([startPromise, stopPromise, transport.close()]);
  });
});
