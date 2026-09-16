import { afterEach, describe, expect, test } from "bun:test";
import { BridgeServerTransport } from "../../agent/src/bridge-server-transport";
import { InMemoryDeviceCredentialRepository } from "./device-credential";
import {
  createDeviceCredentialInvalidationEvent,
  type DeviceCredentialInvalidationBus,
  type DeviceCredentialInvalidationHandler,
  InMemoryDeviceCredentialInvalidationBus,
} from "./device-credential-invalidation";
import { InMemoryDeviceCredentialLifecycleCoordinator } from "./device-credential-lifecycle";
import { InMemoryDeviceRepository } from "./device-repository";
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
        setTimeout(check, 2);
        return;
      }
      clearTimeout(timeout);
      resolve(result);
    };
    check();
  });
}

class DroppingInvalidationBus implements DeviceCredentialInvalidationBus {
  subscribe(_handler: DeviceCredentialInvalidationHandler): () => void {
    return () => undefined;
  }

  async publish(): Promise<void> {
    throw new Error("shared invalidation backend unavailable");
  }
}

describe("M3.4 device session runtime", () => {
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

  async function createPairedRuntime(
    options: Parameters<typeof createDoctmcpServerRuntime>[0] = {},
  ) {
    const runtime = createDoctmcpServerRuntime({
      port: 0,
      idleTimeoutMs: 0,
      heartbeatIntervalMs: 20,
      heartbeatTimeoutMs: 200,
      ...options,
    });
    runtimes.push(runtime);
    const pairing = await runtime.pairingService.createPairingSession({
      localCorrelationId: crypto.randomUUID(),
    });
    const completed =
      await runtime.pairingCredentialCompletionService.claimAndIssue(
        pairing.pairingCode,
        {
          ownerId: "owner-m3-4",
          deviceName: "M3.4 device",
          metadata: { platform: "darwin-arm64" },
        },
      );
    return { runtime, completed };
  }

  function connect(
    runtime: DoctmcpServerRuntime,
    input: { deviceId: string; secret: string; sessionId: string },
  ): BridgeServerTransport {
    const transport = new BridgeServerTransport({
      url: runtime.gateway.url,
      sessionId: input.sessionId,
      auth: {
        deviceId: input.deviceId,
        credential: input.secret,
      },
    });
    transports.push(transport);
    return transport;
  }

  test("duplicate device connection replaces old session without old cleanup deleting new", async () => {
    const { runtime, completed } = await createPairedRuntime();
    const first = connect(runtime, {
      deviceId: completed.device.deviceId,
      secret: completed.secret,
      sessionId: "device-session-old",
    });
    await first.start();

    const second = connect(runtime, {
      deviceId: completed.device.deviceId,
      secret: completed.secret,
      sessionId: "device-session-new",
    });
    await second.start();

    await waitFor(() => (first.state === "closed" ? true : undefined));
    expect(second.state).toBe("ready");
    expect(
      runtime.deviceSessionRegistry.getActive(completed.device.deviceId)
        ?.session.id,
    ).toBe("device-session-new");
    expect(runtime.getDeviceStatus(completed.device.deviceId).status).toBe(
      "online",
    );
  });

  test("valid native heartbeat refreshes lastSeen and disconnect marks device offline immediately", async () => {
    const { runtime, completed } = await createPairedRuntime();
    const transport = connect(runtime, {
      deviceId: completed.device.deviceId,
      secret: completed.secret,
      sessionId: "heartbeat-session",
    });
    await transport.start();

    const initial = runtime.getDeviceStatus(completed.device.deviceId);
    expect(initial.status).toBe("online");
    const initialLastSeen = initial.lastSeenAt?.getTime() ?? 0;

    await waitFor(() => {
      const status = runtime.getDeviceStatus(completed.device.deviceId);
      const lastSeen = status.lastSeenAt?.getTime() ?? 0;
      return lastSeen > initialLastSeen ? status : undefined;
    });

    await transport.close();
    await waitFor(() =>
      runtime.getDeviceStatus(completed.device.deviceId).status === "offline"
        ? true
        : undefined,
    );
    expect(
      runtime.deviceSessionRegistry.getActive(completed.device.deviceId),
    ).toBeNull();
  });

  test("cross-instance rotate/revoke closes stale generation while duplicate delayed events cannot close new generation", async () => {
    const deviceRepository = new InMemoryDeviceRepository();
    const credentialRepository = new InMemoryDeviceCredentialRepository();
    const lifecycle = new InMemoryDeviceCredentialLifecycleCoordinator();
    const invalidationBus = new InMemoryDeviceCredentialInvalidationBus();
    const { runtime: runtimeA, completed } = await createPairedRuntime({
      deviceRepository,
      credentialRepository,
      credentialLifecycleCoordinator: lifecycle,
      credentialInvalidationBus: invalidationBus,
    });
    const runtimeB = createDoctmcpServerRuntime({
      port: 0,
      idleTimeoutMs: 0,
      heartbeatIntervalMs: 20,
      heartbeatTimeoutMs: 200,
      deviceRepository,
      credentialRepository,
      credentialLifecycleCoordinator: lifecycle,
      credentialInvalidationBus: invalidationBus,
    });
    runtimes.push(runtimeB);

    const stale = connect(runtimeB, {
      deviceId: completed.device.deviceId,
      secret: completed.secret,
      sessionId: "cross-instance-old",
    });
    await stale.start();
    expect(runtimeB.getDeviceStatus(completed.device.deviceId).status).toBe(
      "online",
    );

    const rotated = await runtimeA.rotateDeviceCredential(
      completed.device.deviceId,
    );
    await waitFor(() => (stale.state === "closed" ? true : undefined));
    expect(runtimeB.getDeviceStatus(completed.device.deviceId).status).toBe(
      "offline",
    );

    const current = connect(runtimeB, {
      deviceId: completed.device.deviceId,
      secret: rotated.secret,
      sessionId: "cross-instance-current",
    });
    await current.start();

    const delayedOldGenerationEvent = createDeviceCredentialInvalidationEvent({
      eventId: "delayed-old-generation-event",
      kind: "rotated",
      deviceId: completed.device.deviceId,
      credentialId: completed.credential.credentialId,
      credentialVersion: completed.credential.version,
      publishedAt: new Date("2026-09-16T00:00:00.000Z"),
    });
    await invalidationBus.publish(delayedOldGenerationEvent);
    await invalidationBus.publish(delayedOldGenerationEvent);

    expect(current.state).toBe("ready");
    expect(
      runtimeB.deviceSessionRegistry.getActive(completed.device.deviceId)
        ?.session.id,
    ).toBe("cross-instance-current");

    await runtimeA.revokeDeviceCredential(completed.device.deviceId);
    await waitFor(() => (current.state === "closed" ? true : undefined));
    expect(runtimeB.getDeviceStatus(completed.device.deviceId).status).toBe(
      "offline",
    );
  });

  test("heartbeat generation revalidation closes stale remote session when invalidation delivery is degraded", async () => {
    const deviceRepository = new InMemoryDeviceRepository();
    const credentialRepository = new InMemoryDeviceCredentialRepository();
    const lifecycle = new InMemoryDeviceCredentialLifecycleCoordinator();
    const droppingBus = new DroppingInvalidationBus();
    const { runtime: runtimeA, completed } = await createPairedRuntime({
      deviceRepository,
      credentialRepository,
      credentialLifecycleCoordinator: lifecycle,
      credentialInvalidationBus: droppingBus,
    });
    const runtimeB = createDoctmcpServerRuntime({
      port: 0,
      idleTimeoutMs: 0,
      heartbeatIntervalMs: 20,
      heartbeatTimeoutMs: 100,
      deviceRepository,
      credentialRepository,
      credentialLifecycleCoordinator: lifecycle,
      credentialInvalidationBus: droppingBus,
    });
    runtimes.push(runtimeB);

    const stale = connect(runtimeB, {
      deviceId: completed.device.deviceId,
      secret: completed.secret,
      sessionId: "degraded-invalidation-session",
    });
    await stale.start();

    await runtimeA.revokeDeviceCredential(completed.device.deviceId);

    await waitFor(() => (stale.state === "closed" ? true : undefined));
    expect(runtimeB.getDeviceStatus(completed.device.deviceId).status).toBe(
      "offline",
    );
  });
});
