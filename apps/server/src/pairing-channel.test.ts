import { afterEach, describe, expect, test } from "bun:test";
import type { PairingChannelMessage } from "@doctmcp/protocol";
import type { GatewayWebSocketConnection } from "./gateway";
import {
  DEFAULT_PAIRING_DELIVERY_TIMEOUT_MS,
  PairingChannelCoordinator,
  PairingChannelError,
} from "./pairing-channel";
import { InMemoryPairingCredentialCompletionRepository } from "./pairing-credential-completion";
import {
  createDoctmcpServerRuntime,
  type DoctmcpServerRuntime,
} from "./server-runtime";

const OWNER_ID = "owner-channel-test";
const CHANNEL_PROOF = "A".repeat(43);

class FakePairingSocket implements GatewayWebSocketConnection {
  readonly id = crypto.randomUUID();
  readonly messages: PairingChannelMessage[] = [];
  closeCode: number | undefined;

  send(message: string): Promise<void> {
    this.messages.push(JSON.parse(message) as PairingChannelMessage);
    return Promise.resolve();
  }

  close(code = 1000): void {
    this.closeCode = code;
  }
}

async function waitForFrame(
  socket: FakePairingSocket,
  kind: PairingChannelMessage["kind"],
): Promise<PairingChannelMessage> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const frame = socket.messages.find((message) => message.kind === kind);
    if (frame) return frame;
    await Bun.sleep(1);
  }
  throw new Error(`Timed out waiting for ${kind}`);
}

describe("PairingChannelCoordinator", () => {
  const runtimes: DoctmcpServerRuntime[] = [];
  const coordinators: PairingChannelCoordinator[] = [];

  afterEach(async () => {
    await Promise.allSettled(
      coordinators.splice(0).map((coordinator) => coordinator.close()),
    );
    await Promise.allSettled(
      runtimes.splice(0).map((runtime) => runtime.stop()),
    );
  });

  async function createPendingPairing(
    options: { maxPendingSessions?: number; deliveryTimeoutMs?: number } = {},
  ) {
    const runtime = createDoctmcpServerRuntime({ host: "127.0.0.1", port: 0 });
    runtimes.push(runtime);
    const pending = await runtime.pairingService.createPairingSession();
    const coordinator = new PairingChannelCoordinator({
      acknowledgeDelivery: (input) =>
        runtime.pairingCredentialCompletionService.acknowledgeDelivery(input),
      cancelPairingSession: async (pairingSessionId) => {
        await runtime.pairingService.cancelPairingSession(pairingSessionId);
      },
      ...(options.maxPendingSessions !== undefined
        ? { maxPendingSessions: options.maxPendingSessions }
        : {}),
      ...(options.deliveryTimeoutMs !== undefined
        ? { deliveryTimeoutMs: options.deliveryTimeoutMs }
        : {}),
    });
    coordinators.push(coordinator);
    await coordinator.register(pending.session, CHANNEL_PROOF);
    return { coordinator, pending, runtime };
  }

  async function claim(
    runtime: DoctmcpServerRuntime,
    pairing: { readonly pairingCode: string },
  ) {
    return runtime.pairingCredentialCompletionService.claimAndIssue(
      pairing.pairingCode,
      {
        ownerId: OWNER_ID,
        deviceName: "Test device",
        metadata: { platform: "test" },
      },
    );
  }

  test("binds the exact proof and delivers credential only to its attached channel", async () => {
    const { coordinator, pending, runtime } = await createPendingPairing();
    const socket = new FakePairingSocket();

    await expect(
      coordinator.attach(
        pending.session.pairingSessionId,
        "B".repeat(43),
        socket,
      ),
    ).rejects.toBeInstanceOf(PairingChannelError);
    await coordinator.attach(
      pending.session.pairingSessionId,
      CHANNEL_PROOF,
      socket,
    );
    expect(socket.messages[0]).toMatchObject({
      kind: "pairing.attached",
      pairingSessionId: pending.session.pairingSessionId,
    });

    const completed = await claim(runtime, pending);
    const delivered = coordinator.deliver(completed);
    const credentialFrame = await waitForFrame(socket, "pairing.credential");
    expect(credentialFrame).toMatchObject({
      kind: "pairing.credential",
      pairingSessionId: pending.session.pairingSessionId,
      deviceId: completed.device.deviceId,
      credentialId: completed.credential.credentialId,
      version: completed.credential.version,
      credential: completed.secret,
    });
    expect(coordinator.pendingCount).toBe(1);
    const ack = {
      kind: "pairing.ack" as const,
      pairingSessionId: pending.session.pairingSessionId,
      deviceId: completed.device.deviceId,
      credentialId: completed.credential.credentialId,
      version: completed.credential.version,
    };
    await coordinator.acknowledge(socket, ack);
    await expect(delivered).resolves.toBeUndefined();
    expect(socket.closeCode).toBe(1000);
    await expect(
      runtime.pairingCredentialCompletionService.resumeClaimedPairing(
        pending.session.pairingSessionId,
        OWNER_ID,
      ),
    ).rejects.toBeInstanceOf(Error);
  });

  test("resends the same pending credential after reconnect with the same proof", async () => {
    const { coordinator, pending, runtime } = await createPendingPairing();
    const firstSocket = new FakePairingSocket();
    await coordinator.attach(
      pending.session.pairingSessionId,
      CHANNEL_PROOF,
      firstSocket,
    );
    const completed = await claim(runtime, pending);
    const delivered = coordinator.deliver(completed);
    const firstFrame = await waitForFrame(firstSocket, "pairing.credential");

    coordinator.detach(pending.session.pairingSessionId, firstSocket);
    const replacementSocket = new FakePairingSocket();
    await coordinator.attach(
      pending.session.pairingSessionId,
      CHANNEL_PROOF,
      replacementSocket,
    );
    const replacementFrame = await waitForFrame(
      replacementSocket,
      "pairing.credential",
    );
    expect(replacementFrame).toEqual(firstFrame);

    await coordinator.acknowledge(replacementSocket, {
      kind: "pairing.ack",
      pairingSessionId: pending.session.pairingSessionId,
      deviceId: completed.device.deviceId,
      credentialId: completed.credential.credentialId,
      version: completed.credential.version,
    });
    await expect(delivered).resolves.toBeUndefined();
  });

  test("rejects wrong generation ACKs and does not acknowledge completion", async () => {
    const { coordinator, pending, runtime } = await createPendingPairing();
    const socket = new FakePairingSocket();
    await coordinator.attach(
      pending.session.pairingSessionId,
      CHANNEL_PROOF,
      socket,
    );
    const completed = await claim(runtime, pending);
    const delivered = coordinator.deliver(completed);
    await waitForFrame(socket, "pairing.credential");

    await expect(
      coordinator.acknowledge(socket, {
        kind: "pairing.ack",
        pairingSessionId: pending.session.pairingSessionId,
        deviceId: completed.device.deviceId,
        credentialId: completed.credential.credentialId,
        version: completed.credential.version + 1,
      }),
    ).rejects.toMatchObject({ code: "PAIRING_UNAVAILABLE" });

    await coordinator.acknowledge(socket, {
      kind: "pairing.ack",
      pairingSessionId: pending.session.pairingSessionId,
      deviceId: completed.device.deviceId,
      credentialId: completed.credential.credentialId,
      version: completed.credential.version,
    });
    await expect(delivered).resolves.toBeUndefined();
  });

  test("enforces pending capacity and rejects expired sessions", async () => {
    const { coordinator, pending, runtime } = await createPendingPairing({
      maxPendingSessions: 1,
    });
    const another = await runtime.pairingService.createPairingSession();
    await expect(
      coordinator.register(another.session, "C".repeat(43)),
    ).rejects.toMatchObject({
      code: "PAIRING_RATE_LIMITED",
    });

    const expiredCoordinator = new PairingChannelCoordinator({
      acknowledgeDelivery: (input) =>
        runtime.pairingCredentialCompletionService.acknowledgeDelivery(input),
      now: () => new Date(pending.session.expiresAt.getTime() + 1),
    });
    coordinators.push(expiredCoordinator);
    await expect(
      expiredCoordinator.register(pending.session, "C".repeat(43)),
    ).rejects.toMatchObject({ code: "PAIRING_UNAVAILABLE" });
    await expiredCoordinator.close();
    expect(coordinator.pendingCount).toBe(1);
  });

  test("cancels unclaimed pairing sessions during coordinator shutdown", async () => {
    const { coordinator, pending, runtime } = await createPendingPairing();
    await coordinator.close();
    const closedSession = await runtime.pairingService.getPairingSession(
      pending.session.pairingSessionId,
    );
    expect(closedSession?.state).toBe("cancelled");
    expect(coordinator.pendingCount).toBe(0);
  });

  test("times out an MCP waiter and closes all waiters on shutdown", async () => {
    const { coordinator, pending, runtime } = await createPendingPairing({
      deliveryTimeoutMs: 5,
    });
    const socket = new FakePairingSocket();
    await coordinator.attach(
      pending.session.pairingSessionId,
      CHANNEL_PROOF,
      socket,
    );
    const completed = await claim(runtime, pending);

    await expect(coordinator.deliver(completed)).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    expect(coordinator.pendingCount).toBe(1);
    await coordinator.close();
    expect(socket.closeCode).toBe(1012);
    expect(coordinator.pendingCount).toBe(0);
  });

  test("clears a cached credential completion when its pairing channel expires", async () => {
    const runtime = createDoctmcpServerRuntime({ host: "127.0.0.1", port: 0 });
    runtimes.push(runtime);
    const pending = await runtime.pairingService.createPairingSession();
    let now = new Date();
    const coordinator = new PairingChannelCoordinator({
      acknowledgeDelivery: (input) =>
        runtime.pairingCredentialCompletionService.acknowledgeDelivery(input),
      forgetPendingCompletion: (pairingSessionId) =>
        runtime.pairingCredentialCompletionService.forgetPendingCompletion(
          pairingSessionId,
        ),
      now: () => now,
    });
    coordinators.push(coordinator);
    await coordinator.register(pending.session, CHANNEL_PROOF);
    const socket = new FakePairingSocket();
    await coordinator.attach(
      pending.session.pairingSessionId,
      CHANNEL_PROOF,
      socket,
    );
    const completed = await claim(runtime, pending);
    const delivery = coordinator.deliver(completed);
    await waitForFrame(socket, "pairing.credential");

    now = new Date(
      pending.session.expiresAt.getTime() +
        DEFAULT_PAIRING_DELIVERY_TIMEOUT_MS +
        1,
    );
    await expect(
      coordinator.attach(
        pending.session.pairingSessionId,
        CHANNEL_PROOF,
        new FakePairingSocket(),
      ),
    ).rejects.toMatchObject({ code: "PAIRING_UNAVAILABLE" });
    await expect(delivery).rejects.toMatchObject({
      code: "PAIRING_UNAVAILABLE",
    });

    const recovered =
      await runtime.pairingCredentialCompletionService.resumeClaimedPairing(
        pending.session.pairingSessionId,
        OWNER_ID,
      );
    expect(recovered.secret).not.toBe(completed.secret);
    expect(recovered.credential.version).toBe(completed.credential.version + 1);
  });
  test("allows delivery and ACK after the pairing code TTL when claim already won", async () => {
    const runtime = createDoctmcpServerRuntime({ host: "127.0.0.1", port: 0 });
    runtimes.push(runtime);
    const pending = await runtime.pairingService.createPairingSession();
    let now = new Date(pending.session.createdAt);
    const claimTtlMs =
      pending.session.expiresAt.getTime() - pending.session.createdAt.getTime();
    const coordinator = new PairingChannelCoordinator({
      acknowledgeDelivery: (input) =>
        runtime.pairingCredentialCompletionService.acknowledgeDelivery(input),
      forgetPendingCompletion: (pairingSessionId, preserveDelivered) =>
        runtime.pairingCredentialCompletionService.forgetPendingCompletion(
          pairingSessionId,
          preserveDelivered,
        ),
      now: () => now,
      deliveryTimeoutMs: claimTtlMs + 10_000,
    });
    coordinators.push(coordinator);
    await coordinator.register(pending.session, CHANNEL_PROOF);
    const socket = new FakePairingSocket();
    await coordinator.attach(
      pending.session.pairingSessionId,
      CHANNEL_PROOF,
      socket,
    );

    const completed = await claim(runtime, pending);
    expect(completed.session.claimedAt?.getTime()).toBeLessThan(
      completed.session.expiresAt.getTime(),
    );
    now = new Date(pending.session.expiresAt.getTime() + 1);

    const delivered = coordinator.deliver(completed);
    await waitForFrame(socket, "pairing.credential");
    await coordinator.acknowledge(socket, {
      kind: "pairing.ack",
      pairingSessionId: completed.session.pairingSessionId,
      deviceId: completed.device.deviceId,
      credentialId: completed.credential.credentialId,
      version: completed.credential.version,
    });
    await expect(delivered).resolves.toBeUndefined();
  });

  test("bounds and prunes in-memory pairing completion state", async () => {
    let nowMs = Date.parse("2026-09-19T00:00:00.000Z");
    const repository = new InMemoryPairingCredentialCompletionRepository({
      now: () => new Date(nowMs),
      maxRecords: 1,
      retentionMs: 10,
    });
    const first = {
      pairingSessionId: "11111111-1111-4111-8111-111111111111",
      deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      credentialId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      credentialVersion: 1,
    };
    const second = {
      pairingSessionId: "22222222-2222-4222-8222-222222222222",
      deviceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      credentialId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      credentialVersion: 1,
    };

    expect(await repository.setPending(first)).not.toBeNull();
    expect(repository.size).toBe(1);
    expect(await repository.setPending(second)).toBeNull();
    nowMs += 11;
    expect(await repository.get(first.pairingSessionId)).toBeNull();
    expect(repository.size).toBe(0);
    expect(await repository.setPending(second)).not.toBeNull();
    await repository.delete(second.pairingSessionId);
    expect(repository.size).toBe(0);
  });

});
