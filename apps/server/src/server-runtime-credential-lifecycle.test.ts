import { afterEach, describe, expect, test } from "bun:test";
import { InMemoryDeviceCredentialRepository } from "./device-credential";
import { InMemoryDeviceCredentialLifecycleCoordinator } from "./device-credential-lifecycle";
import { InMemoryDeviceRepository } from "./device-repository";
import { InMemoryPairingSessionRepository } from "./pairing";
import {
  InMemoryPairingCredentialCompletionRepository,
  type PairingCredentialCompletionRecord,
  type PairingCredentialCompletionRepository,
} from "./pairing-credential-completion";
import {
  createDoctmcpServerRuntime,
  type DoctmcpServerRuntime,
} from "./server-runtime";

const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

class BlockingCompletionRepository
  implements PairingCredentialCompletionRepository
{
  #blockSetPending = false;
  #setPendingStarted: Promise<void> = Promise.resolve();
  #resolveSetPendingStarted: (() => void) | undefined;
  #releaseSetPending: Promise<void> = Promise.resolve();
  #resolveReleaseSetPending: (() => void) | undefined;

  #blockFinishRecovery = false;
  #finishRecoveryStarted: Promise<void> = Promise.resolve();
  #resolveFinishRecoveryStarted: (() => void) | undefined;
  #releaseFinishRecovery: Promise<void> = Promise.resolve();
  #resolveReleaseFinishRecovery: (() => void) | undefined;

  constructor(
    private readonly delegate: PairingCredentialCompletionRepository,
  ) {}

  blockNextSetPending(): void {
    this.#blockSetPending = true;
    this.#setPendingStarted = new Promise((resolve) => {
      this.#resolveSetPendingStarted = resolve;
    });
    this.#releaseSetPending = new Promise((resolve) => {
      this.#resolveReleaseSetPending = resolve;
    });
  }

  waitUntilSetPendingBlocked(): Promise<void> {
    return this.#setPendingStarted;
  }

  releaseSetPending(): void {
    this.#resolveReleaseSetPending?.();
  }

  blockNextFinishRecovery(): void {
    this.#blockFinishRecovery = true;
    this.#finishRecoveryStarted = new Promise((resolve) => {
      this.#resolveFinishRecoveryStarted = resolve;
    });
    this.#releaseFinishRecovery = new Promise((resolve) => {
      this.#resolveReleaseFinishRecovery = resolve;
    });
  }

  waitUntilFinishRecoveryBlocked(): Promise<void> {
    return this.#finishRecoveryStarted;
  }

  releaseFinishRecovery(): void {
    this.#resolveReleaseFinishRecovery?.();
  }

  get(pairingSessionId: string) {
    return this.delegate.get(pairingSessionId);
  }

  async setPending(
    input: Parameters<PairingCredentialCompletionRepository["setPending"]>[0],
  ) {
    if (this.#blockSetPending) {
      this.#blockSetPending = false;
      this.#resolveSetPendingStarted?.();
      await this.#releaseSetPending;
    }
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
    if (this.#blockFinishRecovery) {
      this.#blockFinishRecovery = false;
      this.#resolveFinishRecoveryStarted?.();
      await this.#releaseFinishRecovery;
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

async function expectPromiseStillPending(
  promise: Promise<unknown>,
): Promise<void> {
  const state = await Promise.race([
    promise.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    Bun.sleep(30).then(() => "pending" as const),
  ]);
  expect(state).toBe("pending");
}

function createSharedFixture() {
  const deviceRepository = new InMemoryDeviceRepository({
    generateDeviceId: () => DEVICE_ID,
  });
  const credentialRepository = new InMemoryDeviceCredentialRepository();
  const pairingRepository = new InMemoryPairingSessionRepository(
    deviceRepository,
  );
  const completionDelegate =
    new InMemoryPairingCredentialCompletionRepository();
  const completionRepository = new BlockingCompletionRepository(
    completionDelegate,
  );
  const credentialLifecycleCoordinator =
    new InMemoryDeviceCredentialLifecycleCoordinator();

  return {
    deviceRepository,
    credentialRepository,
    pairingRepository,
    completionDelegate,
    completionRepository,
    credentialLifecycleCoordinator,
  };
}

function createRuntime(
  fixture: ReturnType<typeof createSharedFixture>,
): DoctmcpServerRuntime {
  return createDoctmcpServerRuntime({
    port: 0,
    idleTimeoutMs: 0,
    deviceRepository: fixture.deviceRepository,
    credentialRepository: fixture.credentialRepository,
    pairingRepository: fixture.pairingRepository,
    pairingCredentialCompletionRepository: fixture.completionRepository,
    credentialLifecycleCoordinator: fixture.credentialLifecycleCoordinator,
  });
}

describe("DoctmcpServerRuntime credential lifecycle linearization", () => {
  const runtimes: DoctmcpServerRuntime[] = [];

  afterEach(async () => {
    await Promise.allSettled(
      runtimes.splice(0).map((runtime) => runtime.stop()),
    );
  });

  test("initial issue giữ lifecycle lock cho tới khi pending completion đã commit", async () => {
    const fixture = createSharedFixture();
    const runtime = createRuntime(fixture);
    runtimes.push(runtime);
    const pairing = await runtime.pairingService.createPairingSession();

    fixture.completionRepository.blockNextSetPending();
    const claimPromise =
      runtime.pairingCredentialCompletionService.claimAndIssue(
        pairing.pairingCode,
        {
          ownerId: "owner-a",
          deviceName: "Initial lifecycle device",
          metadata: { platform: "linux-x64" },
        },
      );
    await fixture.completionRepository.waitUntilSetPendingBlocked();

    const rotatePromise = runtime.rotateDeviceCredential(DEVICE_ID);
    await expectPromiseStillPending(rotatePromise);

    fixture.completionRepository.releaseSetPending();
    const completed = await claimPromise;
    expect(completed.credential.version).toBe(1);

    const rotated = await rotatePromise;
    expect(rotated.credential.version).toBe(2);
    await expect(
      fixture.completionDelegate.get(completed.session.pairingSessionId),
    ).resolves.toMatchObject({
      state: "pending",
      credentialId: completed.credential.credentialId,
      credentialVersion: 1,
    });
  });

  test("recovery giữ lifecycle lock qua rotate + finish trước khi explicit rotate được chạy", async () => {
    const fixture = createSharedFixture();
    const firstRuntime = createRuntime(fixture);
    runtimes.push(firstRuntime);
    const pairing = await firstRuntime.pairingService.createPairingSession();
    const initial =
      await firstRuntime.pairingCredentialCompletionService.claimAndIssue(
        pairing.pairingCode,
        {
          ownerId: "owner-a",
          deviceName: "Recovery lifecycle device",
          metadata: { platform: "linux-x64" },
        },
      );
    await firstRuntime.stop();

    const restarted = createRuntime(fixture);
    runtimes.push(restarted);
    fixture.completionRepository.blockNextFinishRecovery();
    const resumePromise =
      restarted.pairingCredentialCompletionService.resumeClaimedPairing(
        initial.session.pairingSessionId,
        "owner-a",
      );
    await fixture.completionRepository.waitUntilFinishRecoveryBlocked();

    const rotatePromise = restarted.rotateDeviceCredential(DEVICE_ID);
    await expectPromiseStillPending(rotatePromise);

    fixture.completionRepository.releaseFinishRecovery();
    const recovered = await resumePromise;
    expect(recovered.credential.version).toBe(2);

    const rotated = await rotatePromise;
    expect(rotated.credential.version).toBe(3);

    await expect(
      restarted.pairingCredentialCompletionService.resumeClaimedPairing(
        initial.session.pairingSessionId,
        "owner-a",
      ),
    ).rejects.toMatchObject({ code: "PAIRING_COMPLETION_UNAVAILABLE" });
    await expect(
      restarted.pairingCredentialCompletionService.acknowledgeDelivery({
        pairingSessionId: initial.session.pairingSessionId,
        ownerId: "owner-a",
        credentialId: recovered.credential.credentialId,
        credentialVersion: recovered.credential.version,
      }),
    ).rejects.toMatchObject({ code: "PAIRING_COMPLETION_UNAVAILABLE" });
  });

  test("concurrent explicit rotate/revoke vẫn dùng cùng expected generation và chỉ một mutation thắng", async () => {
    const fixture = createSharedFixture();
    const runtime = createRuntime(fixture);
    runtimes.push(runtime);
    const pairing = await runtime.pairingService.createPairingSession();
    const completed =
      await runtime.pairingCredentialCompletionService.claimAndIssue(
        pairing.pairingCode,
        {
          ownerId: "owner-a",
          deviceName: "Concurrent lifecycle device",
          metadata: { platform: "linux-x64" },
        },
      );

    const results = await Promise.allSettled([
      runtime.rotateDeviceCredential(completed.device.deviceId),
      runtime.revokeDeviceCredential(completed.device.deviceId),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });
});
