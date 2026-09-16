import { afterEach, describe, expect, test } from "bun:test";
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeMessage,
} from "@doctmcp/protocol";
import {
  type BridgeGateway,
  type BridgeGatewaySession,
  createBridgeGateway,
  sendWebSocketFrameOrCleanup,
} from "./gateway";

interface ReceivedMessage {
  readonly kind: string;
  readonly [key: string]: unknown;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("WebSocket connection failed")),
      { once: true },
    );
  });
}

function waitForMessage(
  socket: WebSocket,
  predicate: (message: ReceivedMessage) => boolean = () => true,
): Promise<ReceivedMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("Timed out waiting for WebSocket message"));
    }, 2_000);

    function onMessage(event: MessageEvent<string | ArrayBuffer>): void {
      const value =
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data);
      const message = JSON.parse(value) as ReceivedMessage;
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve(message);
    }

    socket.addEventListener("message", onMessage);
  });
}

async function connectLegacySession(
  gateway: BridgeGateway,
  sessionId: string,
): Promise<{ socket: WebSocket; session: BridgeGatewaySession }> {
  const socket = new WebSocket(gateway.url);
  await waitForOpen(socket);
  socket.send(
    JSON.stringify({
      kind: "bridge.hello",
      bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
      role: "local-agent",
      sessionId,
    }),
  );
  await waitForMessage(
    socket,
    (message) => message.kind === "bridge.hello.ack",
  );
  const session = gateway.getSession(sessionId);
  if (!session) throw new Error("Expected ready session");
  return { socket, session };
}

describe("BridgeGateway outbound send failure cleanup", () => {
  let gateway: BridgeGateway | null = null;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await gateway?.stop();
    gateway = null;
  });

  test("wire send failure chạy cleanup trước khi reject", async () => {
    let cleaned = false;
    await expect(
      sendWebSocketFrameOrCleanup(
        () => 0,
        () => {
          cleaned = true;
          return Promise.resolve();
        },
      ),
    ).rejects.toMatchObject({ code: "SESSION_CLOSED" });
    expect(cleaned).toBe(true);
  });

  test("serialize/send failure xoá session ngay cả khi idle timeout bị tắt", async () => {
    gateway = createBridgeGateway({
      port: 0,
      idleTimeoutMs: 0,
      allowLegacyUnauthenticated: true,
    });
    const { socket, session } = await connectLegacySession(
      gateway,
      "send-failure-session",
    );
    sockets.push(socket);

    const invalidMessage = {
      kind: "not-a-bridge-message",
    } as unknown as BridgeMessage;
    await expect(session.send(invalidMessage)).rejects.toMatchObject({
      code: "SESSION_CLOSED",
    });

    expect(gateway.getSession("send-failure-session")).toBeUndefined();
    expect(gateway.sessionCount).toBe(0);
    expect(session.state).not.toBe("ready");
  });
});
