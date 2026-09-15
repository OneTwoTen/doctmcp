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

const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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

function waitForClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) =>
    socket.addEventListener("close", (event) => resolve(event), { once: true }),
  );
}

async function connectClient(gateway: BridgeGateway): Promise<WebSocket> {
  const socket = new WebSocket(gateway.url);
  await waitForOpen(socket);
  return socket;
}

function sendHello(
  socket: WebSocket,
  sessionId = "test-session",
  auth?: { deviceId: string; credential: string },
): void {
  socket.send(
    JSON.stringify({
      kind: "bridge.hello",
      bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
      role: "local-agent",
      sessionId,
      ...(auth ? { auth: { mode: "device", ...auth } } : {}),
    }),
  );
}

function legacyGateway(
  options: Parameters<typeof createBridgeGateway>[0] = {},
): BridgeGateway {
  return createBridgeGateway({
    ...options,
    allowLegacyUnauthenticated: true,
  });
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

  test("production default rejects hello without device auth before creating a session", async () => {
    gateway = createBridgeGateway({ port: 0 });
    const socket = await connectClient(gateway);
    sockets.push(socket);
    const closePromise = waitForClose(socket);
    sendHello(socket);

    await expect(
      waitForMessage(socket, (message) => message.kind === "bridge.error"),
    ).resolves.toMatchObject({
      kind: "bridge.error",
      code: "AUTH_REQUIRED",
    });
    await closePromise;
    expect(gateway.sessionCount).toBe(0);
  });

  test("authenticated hello binds server-side owner/device identity before ready", async () => {
    let readySession: BridgeGatewaySession | undefined;
    gateway = createBridgeGateway({
      port: 0,
      authenticateDevice: async (deviceId, credential) => {
        expect(deviceId).toBe(DEVICE_ID);
        expect(credential).toBe("secret-a");
        return { ownerId: "owner-a", deviceId: DEVICE_ID };
      },
      onSession: (session) => {
        readySession = session;
      },
    });
    const socket = await connectClient(gateway);
    sockets.push(socket);
    sendHello(socket, "authenticated-session", {
      deviceId: DEVICE_ID,
      credential: "secret-a",
    });

    await expect(
      waitForMessage(socket, (message) => message.kind === "bridge.hello.ack"),
    ).resolves.toMatchObject({
      kind: "bridge.hello.ack",
      sessionId: "authenticated-session",
    });
    expect(readySession?.state).toBe("ready");
    expect(readySession?.identity).toEqual({
      ownerId: "owner-a",
      deviceId: DEVICE_ID,
    });
  });

  test("invalid credential fails generically and never exposes ready session", async () => {
    let exposed = false;
    gateway = createBridgeGateway({
      port: 0,
      authenticateDevice: async () => {
        throw new Error("secret-a must never be echoed");
      },
      onSession: () => {
        exposed = true;
      },
    });
    const socket = await connectClient(gateway);
    sockets.push(socket);
    const closePromise = waitForClose(socket);
    sendHello(socket, "bad-auth", {
      deviceId: DEVICE_ID,
      credential: "secret-a",
    });

    const error = await waitForMessage(
      socket,
      (message) => message.kind === "bridge.error",
    );
    expect(error).toMatchObject({
      kind: "bridge.error",
      code: "AUTH_FAILED",
      message: "Device authentication failed",
    });
    expect(JSON.stringify(error)).not.toContain("secret-a");
    await closePromise;
    expect(exposed).toBe(false);
    expect(gateway.sessionCount).toBe(0);
  });

  test("rejects MCP before authentication", async () => {
    gateway = createBridgeGateway({ port: 0 });
    const socket = await connectClient(gateway);
    sockets.push(socket);
    const closePromise = waitForClose(socket);
    socket.send(
      JSON.stringify({
        kind: "mcp.message",
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        },
      }),
    );

    await expect(
      waitForMessage(socket, (message) => message.kind === "bridge.error"),
    ).resolves.toMatchObject({
      code: "HANDSHAKE_REQUIRED",
    });
    await closePromise;
    expect(gateway.sessionCount).toBe(0);
  });

  test("explicit M2 compatibility accepts legacy handshake", async () => {
    let readySession: BridgeGatewaySession | undefined;
    gateway = legacyGateway({
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
    expect(readySession?.identity).toBeNull();
    expect(gateway.getSession("session-1")).toBe(readySession);
  });

  test("forwards opaque MCP envelopes in both directions in explicit legacy mode", async () => {
    let readySession: BridgeGatewaySession | undefined;
    gateway = legacyGateway({
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
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      },
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

  test("rejects malformed and oversized frames", async () => {
    gateway = legacyGateway({ port: 0 });
    let socket = await connectClient(gateway);
    sockets.push(socket);
    let closePromise = waitForClose(socket);
    socket.send("not-json");

    await expect(
      waitForMessage(socket, (message) => message.kind === "bridge.error"),
    ).resolves.toMatchObject({ code: "INVALID_MESSAGE" });
    await closePromise;

    socket = await connectClient(gateway);
    sockets.push(socket);
    closePromise = waitForClose(socket);
    socket.send(
      JSON.stringify({
        kind: "bridge.hello",
        bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
        role: "local-agent",
        sessionId: "x".repeat(BRIDGE_MAX_MESSAGE_BYTES),
      }),
    );

    await expect(
      waitForMessage(socket, (message) => message.kind === "bridge.error"),
    ).resolves.toMatchObject({ code: "MESSAGE_TOO_LARGE" });
    await closePromise;
  });

  test("rejects unsupported version and handshake timeout", async () => {
    gateway = legacyGateway({ port: 0, handshakeTimeoutMs: 25 });
    let socket = await connectClient(gateway);
    sockets.push(socket);
    let closePromise = waitForClose(socket);
    socket.send(
      JSON.stringify({
        kind: "bridge.hello",
        bridgeProtocolVersion: "999",
        role: "local-agent",
        sessionId: "bad-version",
      }),
    );

    await expect(
      waitForMessage(socket, (message) => message.kind === "bridge.error"),
    ).resolves.toMatchObject({ code: "UNSUPPORTED_VERSION" });
    await closePromise;

    socket = await connectClient(gateway);
    sockets.push(socket);
    closePromise = waitForClose(socket);
    await expect(
      waitForMessage(socket, (message) => message.kind === "bridge.error"),
    ).resolves.toMatchObject({ code: "TIMEOUT" });
    await closePromise;
  });

  test("cleans up remote and repeated local close", async () => {
    gateway = legacyGateway({ port: 0 });
    let socket = await connectClient(gateway);
    sockets.push(socket);
    sendHello(socket, "remote");
    await waitForMessage(
      socket,
      (message) => message.kind === "bridge.hello.ack",
    );
    const remote = gateway.getSession("remote");
    if (!remote) throw new Error("Expected session");
    const remoteReason = new Promise<string>((resolve) => {
      remote.onclose = resolve;
    });
    socket.close();
    await expect(remoteReason).resolves.toBe("REMOTE_CLOSE");

    socket = await connectClient(gateway);
    sockets.push(socket);
    sendHello(socket, "local");
    await waitForMessage(
      socket,
      (message) => message.kind === "bridge.hello.ack",
    );
    const local = gateway.getSession("local");
    if (!local) throw new Error("Expected session");
    const closePromise = waitForClose(socket);
    await Promise.all([local.close(), local.close()]);
    await closePromise;
    expect(gateway.getSession("local")).toBeUndefined();
  });
});
