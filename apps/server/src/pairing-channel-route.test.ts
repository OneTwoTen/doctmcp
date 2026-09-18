import { afterEach, describe, expect, test } from "bun:test";
import type { PairingChannelMessage } from "@doctmcp/protocol";
import type { GatewayWebSocketConnection } from "./gateway";
import { PairingChannelCoordinator } from "./pairing-channel";
import {
  createPairingChannelWebSocketRoute,
  PAIRING_CHANNEL_PATH,
} from "./pairing-channel-route";
import {
  createDoctmcpServerRuntime,
  type DoctmcpServerRuntime,
} from "./server-runtime";

const CHANNEL_PROOF = "A".repeat(43);

class FakeRouteSocket implements GatewayWebSocketConnection {
  readonly id = crypto.randomUUID();
  readonly messages: PairingChannelMessage[] = [];
  closeCode: number | undefined;

  send(raw: string): Promise<void> {
    this.messages.push(JSON.parse(raw) as PairingChannelMessage);
    return Promise.resolve();
  }

  close(code = 1000): void {
    this.closeCode = code;
  }
}

async function waitForCredential(socket: FakeRouteSocket) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const frame = socket.messages.find(
      (message) => message.kind === "pairing.credential",
    );
    if (frame?.kind === "pairing.credential") return frame;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for credential frame");
}

describe("Pairing channel WebSocket route", () => {
  let runtime: DoctmcpServerRuntime | undefined;
  let coordinator: PairingChannelCoordinator | undefined;

  afterEach(async () => {
    await coordinator?.close();
    await runtime?.stop();
    coordinator = undefined;
    runtime = undefined;
  });

  test("routes only attach/ack control frames to the pairing coordinator", async () => {
    runtime = createDoctmcpServerRuntime({ host: "127.0.0.1", port: 0 });
    const pairing = await runtime.pairingService.createPairingSession();
    coordinator = new PairingChannelCoordinator({
      acknowledgeDelivery: (input) =>
        runtime?.pairingCredentialCompletionService.acknowledgeDelivery(
          input,
        ) ?? Promise.reject(new Error("runtime stopped")),
      cancelPairingSession: (pairingSessionId) =>
        runtime?.pairingService
          .cancelPairingSession(pairingSessionId)
          .then(() => undefined) ??
        Promise.reject(new Error("runtime stopped")),
    });
    await coordinator.register(pairing.session, CHANNEL_PROOF);
    const route = createPairingChannelWebSocketRoute(coordinator);
    expect(route.path).toBe(PAIRING_CHANNEL_PATH);

    const socket = new FakeRouteSocket();
    route.open(socket);
    await route.message(
      socket,
      JSON.stringify({
        kind: "pairing.attach",
        pairingSessionId: pairing.session.pairingSessionId,
        channelProof: CHANNEL_PROOF,
      }),
    );
    expect(socket.messages[0]).toMatchObject({
      kind: "pairing.attached",
      pairingSessionId: pairing.session.pairingSessionId,
    });

    const completed =
      await runtime.pairingCredentialCompletionService.claimAndIssue(
        pairing.pairingCode,
        {
          ownerId: "route-owner",
          deviceName: "Route test device",
          metadata: { platform: "test" },
        },
      );
    const delivery = coordinator.deliver(completed);
    const credentialFrame = await waitForCredential(socket);
    expect(credentialFrame.credential).toBe(completed.secret);
    await route.message(
      socket,
      JSON.stringify({
        kind: "pairing.ack",
        pairingSessionId: pairing.session.pairingSessionId,
        deviceId: completed.device.deviceId,
        credentialId: completed.credential.credentialId,
        version: completed.credential.version,
      }),
    );
    await expect(delivery).resolves.toBeUndefined();
    expect(socket.closeCode).toBe(1000);
    route.close(socket);
  });

  test("rejects malformed frames with a generic protocol error", async () => {
    runtime = createDoctmcpServerRuntime({ host: "127.0.0.1", port: 0 });
    coordinator = new PairingChannelCoordinator({
      acknowledgeDelivery: async () => undefined,
    });
    const route = createPairingChannelWebSocketRoute(coordinator);
    const socket = new FakeRouteSocket();
    route.open(socket);
    await route.message(socket, "not-json");
    expect(socket.messages).toEqual([
      { kind: "pairing.error", code: "PROTOCOL_ERROR" },
    ]);
    expect(socket.closeCode).toBe(1002);
    route.close(socket);
  });
});
