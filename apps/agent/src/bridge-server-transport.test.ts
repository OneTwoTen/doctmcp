import { afterEach, describe, expect, test } from "bun:test";
import {
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeMessage,
} from "@doctmcp/protocol";
import { BridgeServerTransport } from "./bridge-server-transport";
import { createLocalMcpRuntime } from "./local-mcp-runtime";
import { WorkspaceRegistry } from "./workspace";

interface TestSocketData {
  readonly connection: string;
}

interface BridgePeer {
  readonly url: string;
  readonly received: readonly BridgeMessage[];
  waitForMessage(
    predicate: (message: BridgeMessage) => boolean,
  ): Promise<BridgeMessage>;
  send(message: BridgeMessage): void;
  sendRaw(frame: string): void;
  waitForClose(): Promise<{ code: number; reason: string }>;
  close(): void;
  stop(): Promise<void>;
}

type McpBridgeMessage = Extract<BridgeMessage, { kind: "mcp.message" }>;

function isMcpMessage(message: BridgeMessage): message is McpBridgeMessage {
  return message.kind === "mcp.message";
}

function expectMcpMessage(message: BridgeMessage): McpBridgeMessage {
  if (!isMcpMessage(message)) throw new Error("Expected an MCP bridge message");
  return message;
}

function parseBridgeMessage(raw: string | Buffer): BridgeMessage {
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  return JSON.parse(text) as BridgeMessage;
}

function createBridgePeer(
  onMessage?: (
    socket: Bun.ServerWebSocket<TestSocketData>,
    message: BridgeMessage,
  ) => void,
  acknowledge = true,
): BridgePeer {
  let socket: Bun.ServerWebSocket<TestSocketData> | undefined;
  let resolveClose:
    | ((event: { code: number; reason: string }) => void)
    | undefined;
  const closePromise = new Promise<{ code: number; reason: string }>(
    (resolve) => {
      resolveClose = resolve;
    },
  );
  const receivedMessages: BridgeMessage[] = [];
  const waiters: Array<{
    predicate: (message: BridgeMessage) => boolean;
    resolve: (message: BridgeMessage) => void;
  }> = [];

  const publish = (message: BridgeMessage): void => {
    receivedMessages.push(message);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (!waiter?.predicate(message)) continue;
      waiters.splice(index, 1);
      waiter.resolve(message);
    }
  };

  const server = Bun.serve<TestSocketData>({
    port: 0,
    websocket: {
      data: { connection: "test" },
      open(nextSocket) {
        socket = nextSocket;
      },
      message(nextSocket, raw) {
        const message = parseBridgeMessage(raw);
        publish(message);
        if (acknowledge && message.kind === "bridge.hello") {
          nextSocket.send(
            JSON.stringify({
              kind: "bridge.hello.ack",
              bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
              role: "public-server",
              sessionId: message.sessionId,
            }),
          );
        }
        onMessage?.(nextSocket, message);
      },
      close(_nextSocket, code, reason) {
        resolveClose?.({ code, reason });
      },
    },
    fetch(request, serverInstance) {
      if (serverInstance.upgrade(request, { data: { connection: "test" } }))
        return;
      return new Response("WebSocket upgrade required", { status: 400 });
    },
  });

  return {
    url: `ws://${server.hostname}:${server.port}`,
    get received() {
      return receivedMessages;
    },
    waitForMessage(predicate) {
      const existing = receivedMessages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
    send(message) {
      if (!socket) throw new Error("Bridge peer is not connected");
      socket.send(JSON.stringify(message));
    },
    sendRaw(frame) {
      if (!socket) throw new Error("Bridge peer is not connected");
      socket.send(frame);
    },
    waitForClose() {
      return closePromise;
    },
    close() {
      socket?.close();
    },
    async stop() {
      socket?.close();
      await server.stop(true);
    },
  };
}

class ControlledWebSocket extends EventTarget {
  bufferedAmount = 0;
  readyState: number = WebSocket.CONNECTING;

  send(data: string): void {
    this.bufferedAmount += new TextEncoder().encode(data).byteLength;
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  emitMessage(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  emitError(): void {
    this.dispatchEvent(new Event("error"));
  }

  drain(): void {
    this.bufferedAmount = 0;
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
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

describe("BridgeServerTransport", () => {
  const peers: BridgePeer[] = [];
  const transports: BridgeServerTransport[] = [];

  afterEach(async () => {
    await Promise.allSettled(
      transports.splice(0).map((transport) => transport.close()),
    );
    await Promise.allSettled(peers.splice(0).map((peer) => peer.stop()));
  });

  test("connects, handshakes and round-trips MCP messages over a real WebSocket", async () => {
    const peer = createBridgePeer();
    peers.push(peer);
    const transport = new BridgeServerTransport({
      url: peer.url,
      sessionId: "transport-test-session",
    });
    transports.push(transport);
    const incoming: unknown[] = [];
    transport.onmessage = (message) => incoming.push(message);

    await transport.start();

    expect(transport.state).toBe("ready");
    expect(transport.mcpRole).toBe("server");
    await expect(
      peer.waitForMessage((message) => message.kind === "bridge.hello"),
    ).resolves.toEqual({
      kind: "bridge.hello",
      bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
      role: "local-agent",
      sessionId: "transport-test-session",
    });

    const request = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "tools/list" as const,
    };
    await transport.send(request);
    await expect(
      peer.waitForMessage((message) => message.kind === "mcp.message"),
    ).resolves.toEqual({ kind: "mcp.message", payload: request });

    peer.send({
      kind: "mcp.message",
      payload: { jsonrpc: "2.0", id: 1, result: { tools: [] } },
    });
    await waitFor(() => incoming[0]);
    expect(incoming).toEqual([
      { jsonrpc: "2.0", id: 1, result: { tools: [] } },
    ]);
  });

  test("rejects send before handshake and after close, and closes idempotently", async () => {
    const peer = createBridgePeer();
    peers.push(peer);
    const transport = new BridgeServerTransport({ url: peer.url });
    transports.push(transport);

    await expect(
      transport.send({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).rejects.toMatchObject({ code: "HANDSHAKE_REQUIRED" });

    await transport.start();
    let closeCalls = 0;
    transport.onclose = () => {
      closeCalls += 1;
    };
    await Promise.all([transport.close(), transport.close()]);
    expect(closeCalls).toBe(1);
    expect(transport.state).toBe("closed");
    await expect(
      transport.send({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).rejects.toMatchObject({ code: "SESSION_CLOSED" });
  });

  test("maps a remote bridge.close to one local close callback", async () => {
    const peer = createBridgePeer();
    peers.push(peer);
    const transport = new BridgeServerTransport({ url: peer.url });
    transports.push(transport);
    const closeReasons: string[] = [];
    const errors: Error[] = [];
    transport.onclose = () => closeReasons.push("closed");
    transport.onerror = (error) => errors.push(error);

    await transport.start();
    peer.send({ kind: "bridge.close", code: "NORMAL" });
    await waitFor(() => (transport.state === "closed" ? true : undefined));

    expect(closeReasons).toEqual(["closed"]);
    expect(errors).toEqual([]);
  });

  test("uses TIMEOUT for handshake failure in both bridge and native close", async () => {
    const peer = createBridgePeer(undefined, false);
    peers.push(peer);
    const transport = new BridgeServerTransport({
      url: peer.url,
      handshakeTimeoutMs: 20,
    });
    transports.push(transport);
    const errors: Error[] = [];
    transport.onerror = (error) => errors.push(error);

    await expect(transport.start()).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(
      peer.waitForMessage((message) => message.kind === "bridge.close"),
    ).resolves.toEqual({ kind: "bridge.close", code: "TIMEOUT" });
    await expect(peer.waitForClose()).resolves.toMatchObject({ code: 1001 });
    expect(errors[0]).toMatchObject({ code: "TIMEOUT" });
  });

  test("reports native socket errors and unexpected native closes", async () => {
    const socket = new ControlledWebSocket();
    const transport = new BridgeServerTransport({
      url: "ws://controlled.test",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    transports.push(transport);
    const errors: Error[] = [];
    transport.onerror = (error) => errors.push(error);
    const started = transport.start();
    socket.open();
    socket.emitMessage(
      JSON.stringify({
        kind: "bridge.hello.ack",
        bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
        role: "public-server",
        sessionId: transport.sessionId,
      }),
    );
    await started;
    socket.emitError();
    await waitFor(() => (transport.state === "closed" ? true : undefined));
    expect(errors[0]).toMatchObject({ code: "SOCKET_ERROR" });

    const peer = createBridgePeer();
    peers.push(peer);
    const unexpectedTransport = new BridgeServerTransport({ url: peer.url });
    transports.push(unexpectedTransport);
    const unexpectedErrors: Error[] = [];
    unexpectedTransport.onerror = (error) => unexpectedErrors.push(error);
    await unexpectedTransport.start();
    peer.close();
    await waitFor(() =>
      unexpectedTransport.state === "closed" ? true : undefined,
    );
    expect(unexpectedErrors[0]).toMatchObject({ code: "SESSION_CLOSED" });
  });

  test("preserves FIFO ordering and rejects a full bounded queue", async () => {
    const peer = createBridgePeer();
    peers.push(peer);
    const transport = new BridgeServerTransport({ url: peer.url });
    transports.push(transport);
    await transport.start();

    const sends = Array.from({ length: transport.maxQueuedMessages }, (_, id) =>
      transport.send({ jsonrpc: "2.0", id, method: "notifications/test" }),
    );
    await expect(
      transport.send({
        jsonrpc: "2.0",
        id: "overflow",
        method: "notifications/test",
      }),
    ).rejects.toMatchObject({ code: "BACKPRESSURE" });
    await Promise.all(sends);
    await waitFor(() => {
      const count = peer.received.filter(
        (message) => message.kind === "mcp.message",
      ).length;
      return count === transport.maxQueuedMessages ? true : undefined;
    });

    const ids = peer.received
      .filter((message): message is McpBridgeMessage => isMcpMessage(message))
      .map((message) => message.payload.id);
    expect(ids).toEqual(
      Array.from({ length: transport.maxQueuedMessages }, (_, id) => id),
    );
  });

  test("counts native buffered bytes while a slow socket is still pending", async () => {
    const socket = new ControlledWebSocket();
    const transport = new BridgeServerTransport({
      url: "ws://controlled.test",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    transports.push(transport);
    const started = transport.start();
    socket.open();
    socket.emitMessage(
      JSON.stringify({
        kind: "bridge.hello.ack",
        bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
        role: "public-server",
        sessionId: transport.sessionId,
      }),
    );
    await started;

    const sends = [
      transport.send({ jsonrpc: "2.0", id: 0, method: "notifications/test" }),
      ...Array.from({ length: transport.maxQueuedMessages - 1 }, (_, id) =>
        transport.send({
          jsonrpc: "2.0",
          id: id + 1,
          method: "notifications/test",
        }),
      ),
    ];
    await Promise.resolve();
    expect(socket.bufferedAmount).toBeGreaterThan(0);
    await expect(
      transport.send({
        jsonrpc: "2.0",
        id: "overflow",
        method: "notifications/test",
      }),
    ).rejects.toMatchObject({ code: "BACKPRESSURE" });

    await transport.close();
    await Promise.allSettled(sends);
  });

  test("rejects when native-pending bytes plus queued bytes exceed 4 MiB", async () => {
    const socket = new ControlledWebSocket();
    const transport = new BridgeServerTransport({
      url: "ws://controlled.test",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    transports.push(transport);
    const started = transport.start();
    socket.open();
    socket.emitMessage(
      JSON.stringify({
        kind: "bridge.hello.ack",
        bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
        role: "public-server",
        sessionId: transport.sessionId,
      }),
    );
    await started;

    const largeMessage = {
      jsonrpc: "2.0" as const,
      method: "notifications/test" as const,
      params: { value: "x".repeat(900_000) },
    };
    const sends = [
      transport.send(largeMessage),
      transport.send(largeMessage),
      transport.send(largeMessage),
      transport.send(largeMessage),
    ];
    await expect(transport.send(largeMessage)).rejects.toMatchObject({
      code: "BACKPRESSURE",
    });

    await transport.close();
    await Promise.allSettled(sends);
  });

  test("rejects malformed inbound frames without forwarding them to MCP", async () => {
    const peer = createBridgePeer();
    peers.push(peer);
    const transport = new BridgeServerTransport({ url: peer.url });
    transports.push(transport);
    const received: unknown[] = [];
    const errors: Error[] = [];
    transport.onmessage = (message) => received.push(message);
    transport.onerror = (error) => errors.push(error);

    await transport.start();
    peer.sendRaw("not-json");

    await waitFor(() => (transport.state === "closed" ? true : undefined));
    expect(received).toEqual([]);
    expect(errors[0]).toMatchObject({ code: "INVALID_MESSAGE" });
  });

  test("enforces the wire-size limit before sending an MCP frame", async () => {
    const peer = createBridgePeer();
    peers.push(peer);
    const transport = new BridgeServerTransport({ url: peer.url });
    transports.push(transport);
    await transport.start();

    await expect(
      transport.send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "x",
          arguments: { value: "x".repeat(BRIDGE_MAX_MESSAGE_BYTES) },
        },
      }),
    ).rejects.toMatchObject({ code: "MESSAGE_TOO_LARGE" });
    expect(
      peer.received.filter((message) => message.kind === "mcp.message"),
    ).toHaveLength(0);
  });

  test("assembles the production local runtime on the transport and serves MCP calls", async () => {
    const peer = createBridgePeer();
    peers.push(peer);
    const registry = await WorkspaceRegistry.create([]);
    const runtime = createLocalMcpRuntime(registry);
    const transport = new BridgeServerTransport({ url: peer.url });
    transports.push(transport);
    await runtime.connect(transport);

    peer.send({
      kind: "mcp.message",
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "public-test-client", version: "0.1.0" },
        },
      },
    });
    const initializeResult = expectMcpMessage(
      await peer.waitForMessage(
        (message) => isMcpMessage(message) && message.payload.id === 1,
      ),
    );
    expect(initializeResult.payload.result).toMatchObject({
      serverInfo: { name: "doctmcp-agent" },
    });
    peer.send({
      kind: "mcp.message",
      payload: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    peer.send({
      kind: "mcp.message",
      payload: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    });
    const toolsList = expectMcpMessage(
      await peer.waitForMessage(
        (message) => isMcpMessage(message) && message.payload.id === 2,
      ),
    );
    expect(
      (toolsList.payload.result as { tools: unknown[] }).tools,
    ).toHaveLength(6);

    peer.send({
      kind: "mcp.message",
      payload: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "system", arguments: { action: "info" } },
      },
    });
    const callResult = expectMcpMessage(
      await peer.waitForMessage(
        (message) => isMcpMessage(message) && message.payload.id === 3,
      ),
    );
    expect(callResult.payload.result).toMatchObject({
      structuredContent: { runtime: { name: "bun" } },
    });

    await runtime.close();
  });
});
