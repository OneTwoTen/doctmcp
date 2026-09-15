import { afterEach, describe, expect, test } from "bun:test";
import {
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeMessage,
} from "@doctmcp/protocol";
import {
  type BridgeGateway,
  type BridgeGatewaySession,
  createBridgeGateway,
  sendWebSocketFrameOnce,
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
      {
        once: true,
      },
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

function waitForClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => {
    socket.addEventListener("close", (event) => resolve(event), { once: true });
  });
}

async function connectClient(gateway: BridgeGateway): Promise<WebSocket> {
  const socket = new WebSocket(gateway.url);
  await waitForOpen(socket);
  return socket;
}

function sendHello(socket: WebSocket, sessionId = "test-session"): void {
  socket.send(
    JSON.stringify({
      kind: "bridge.hello",
      bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
      role: "local-agent",
      sessionId,
    }),
  );
}

describe("BridgeGateway", () => {
  let gateway: BridgeGateway | null = null;
  let sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets = [];
    await gateway?.stop();
    gateway = null;
  });

  test("treats Bun backpressure status -1 as accepted without retrying", () => {
    let sendCount = 0;

    expect(() =>
      sendWebSocketFrameOnce(() => {
        sendCount += 1;
        return -1;
      }),
    ).not.toThrow();
    expect(sendCount).toBe(1);
  });

  test("accepts a local-first handshake and exposes a ready session", async () => {
    let readySession: BridgeGatewaySession | undefined;
    gateway = createBridgeGateway({
      port: 0,
      onSession: (session) => {
        readySession = session;
      },
    });
    const socket = await connectClient(gateway);
    sockets.push(socket);

    sendHello(socket, "session-1");
    const ack = await waitForMessage(socket);

    expect(ack).toEqual({
      kind: "bridge.hello.ack",
      bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
      role: "public-server",
      sessionId: "session-1",
    });
    expect(gateway.sessionCount).toBe(1);
    expect(readySession).toBeDefined();
    expect(readySession?.id).toBe("session-1");
    expect(readySession?.state).toBe("ready");
    expect(gateway.getSession("session-1")).toBe(readySession);
  });

  test("forwards opaque MCP envelopes in both directions", async () => {
    let readySession: BridgeGatewaySession | undefined;
    gateway = createBridgeGateway({
      port: 0,
      onSession: (session) => {
        readySession = session;
      },
    });
    const socket = await connectClient(gateway);
    sockets.push(socket);
    sendHello(socket);
    await waitForMessage(
      socket,
      (message) => message.kind === "bridge.hello.ack",
    );

    const incomingPromise = new Promise<BridgeMessage>((resolve) => {
      if (!readySession) throw new Error("Expected a ready session");
      readySession.onmessage = resolve;
    });
    const incoming: BridgeMessage = {
      kind: "mcp.message",
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    };
    socket.send(JSON.stringify(incoming));
    await expect(incomingPromise).resolves.toEqual(incoming);

    const outgoing: BridgeMessage = {
      kind: "mcp.message",
      payload: {
        jsonrpc: "2.0",
        id: 1,
        result: { tools: [] },
      },
    };
    const outgoingPromise = waitForMessage(
      socket,
      (message) => message.kind === "mcp.message",
    );
    await readySession?.send(outgoing);
    await expect(outgoingPromise).resolves.toEqual(outgoing);
  });

  test("rejects malformed frames and closes the session deterministically", async () => {
    gateway = createBridgeGateway({ port: 0 });
    const socket = await connectClient(gateway);
    sockets.push(socket);
    const closePromise = waitForClose(socket);

    socket.send("not-json");
    const error = await waitForMessage(
      socket,
      (message) => message.kind === "bridge.error",
    );
    const closeFrame = await waitForMessage(
      socket,
      (message) => message.kind === "bridge.close",
    );

    expect(error).toMatchObject({
      kind: "bridge.error",
      code: "INVALID_MESSAGE",
    });
    expect(closeFrame).toEqual({
      kind: "bridge.close",
      code: "PROTOCOL_ERROR",
    });
    expect((await closePromise).code).toBe(1002);
    expect(gateway.sessionCount).toBe(0);
  });

  test("rejects an oversized UTF-8 frame before parsing it", async () => {
    gateway = createBridgeGateway({ port: 0 });
    const socket = await connectClient(gateway);
    sockets.push(socket);
    const closePromise = waitForClose(socket);
    const oversized = JSON.stringify({
      kind: "bridge.hello",
      bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
      role: "local-agent",
      sessionId: "x".repeat(BRIDGE_MAX_MESSAGE_BYTES),
    });

    socket.send(oversized);
    const error = await waitForMessage(
      socket,
      (message) => message.kind === "bridge.error",
    );

    expect(error).toMatchObject({
      kind: "bridge.error",
      code: "MESSAGE_TOO_LARGE",
    });
    expect((await closePromise).code).toBe(1002);
  });

  test("rejects an unsupported bridge protocol version", async () => {
    gateway = createBridgeGateway({ port: 0 });
    const socket = await connectClient(gateway);
    sockets.push(socket);
    const closePromise = waitForClose(socket);

    socket.send(
      JSON.stringify({
        kind: "bridge.hello",
        bridgeProtocolVersion: "999",
        role: "local-agent",
        sessionId: "unsupported-version",
      }),
    );
    const error = await waitForMessage(
      socket,
      (message) => message.kind === "bridge.error",
    );
    const closeFrame = await waitForMessage(
      socket,
      (message) => message.kind === "bridge.close",
    );

    expect(error).toMatchObject({
      kind: "bridge.error",
      code: "UNSUPPORTED_VERSION",
    });
    expect(closeFrame).toEqual({
      kind: "bridge.close",
      code: "PROTOCOL_ERROR",
    });
    expect((await closePromise).code).toBe(1002);
    expect(gateway.sessionCount).toBe(0);
  });

  test("times out a connection that never completes handshake", async () => {
    gateway = createBridgeGateway({ port: 0, handshakeTimeoutMs: 20 });
    const socket = await connectClient(gateway);
    sockets.push(socket);
    const errorPromise = waitForMessage(
      socket,
      (message) => message.kind === "bridge.error",
    );
    const closePromise = waitForClose(socket);

    await expect(errorPromise).resolves.toMatchObject({
      kind: "bridge.error",
      code: "TIMEOUT",
    });
    expect((await closePromise).code).toBe(1001);
    expect(gateway.sessionCount).toBe(0);
  });

  test("handles an inbound bridge.close and preserves its close reason", async () => {
    let readySession: BridgeGatewaySession | undefined;
    gateway = createBridgeGateway({
      port: 0,
      onSession: (session) => {
        readySession = session;
      },
    });
    const socket = await connectClient(gateway);
    sockets.push(socket);
    sendHello(socket);
    await waitForMessage(
      socket,
      (message) => message.kind === "bridge.hello.ack",
    );

    const reasons: string[] = [];
    const closeReason = new Promise<string>((resolve) => {
      if (!readySession) throw new Error("Expected a ready session");
      readySession.onclose = (reason) => {
        reasons.push(reason);
        resolve(reason);
      };
    });
    const closePromise = waitForClose(socket);
    socket.send(JSON.stringify({ kind: "bridge.close", code: "NORMAL" }));

    await expect(closeReason).resolves.toBe("NORMAL");
    expect((await closePromise).code).toBe(1000);
    expect(reasons).toEqual(["NORMAL"]);
    expect(gateway.sessionCount).toBe(0);
  });

  test("maps an idle timeout to TIMEOUT instead of REMOTE_CLOSE", async () => {
    let readySession: BridgeGatewaySession | undefined;
    gateway = createBridgeGateway({
      port: 0,
      idleTimeoutMs: 25,
      onSession: (session) => {
        readySession = session;
      },
    });
    const socket = await connectClient(gateway);
    sockets.push(socket);
    sendHello(socket);
    await waitForMessage(
      socket,
      (message) => message.kind === "bridge.hello.ack",
    );

    const closeReason = new Promise<string>((resolve) => {
      if (!readySession) throw new Error("Expected a ready session");
      readySession.onclose = resolve;
    });
    const closePromise = waitForClose(socket);

    await expect(closeReason).resolves.toBe("TIMEOUT");
    expect((await closePromise).code).toBe(1001);
    expect(gateway.sessionCount).toBe(0);
  });

  test("maps a client disconnect to REMOTE_CLOSE and cleans up", async () => {
    let readySession: BridgeGatewaySession | undefined;
    gateway = createBridgeGateway({
      port: 0,
      onSession: (session) => {
        readySession = session;
      },
    });
    const socket = await connectClient(gateway);
    sockets.push(socket);
    sendHello(socket);
    await waitForMessage(
      socket,
      (message) => message.kind === "bridge.hello.ack",
    );

    const closeReason = new Promise<string>((resolve) => {
      if (!readySession) throw new Error("Expected a ready session");
      readySession.onclose = resolve;
    });
    const closePromise = waitForClose(socket);
    socket.close();

    await expect(closeReason).resolves.toBe("REMOTE_CLOSE");
    await closePromise;
    expect(gateway.sessionCount).toBe(0);
  });

  test("cleans up a normally closed session and tolerates repeated stop", async () => {
    gateway = createBridgeGateway({ port: 0 });
    const socket = await connectClient(gateway);
    sockets.push(socket);
    sendHello(socket);
    await waitForMessage(
      socket,
      (message) => message.kind === "bridge.hello.ack",
    );
    const session = gateway.getSession("test-session");
    expect(session).toBeDefined();

    const reasons: string[] = [];
    if (!session) throw new Error("Expected a ready session");
    session.onclose = (reason) => reasons.push(reason);
    const closePromise = waitForClose(socket);
    await Promise.all([session.close(), session.close()]);
    await closePromise;
    expect(gateway.sessionCount).toBe(0);
    expect(reasons).toEqual(["NORMAL"]);
    await gateway.stop();
    await gateway.stop();
  });
});
