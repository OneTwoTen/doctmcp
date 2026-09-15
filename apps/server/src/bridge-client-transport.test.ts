import { afterEach, describe, expect, test } from "bun:test";
import {
  BRIDGE_MAX_QUEUED_MESSAGES,
  type BridgeCloseCode,
  type BridgeMessage,
} from "@doctmcp/protocol";
import { Client } from "@modelcontextprotocol/client";
import { BridgeServerTransport } from "../../agent/src/bridge-server-transport";
import { createLocalMcpRuntime } from "../../agent/src/local-mcp-runtime";
import { WorkspaceRegistry } from "../../agent/src/workspace";
import {
  BridgeClientTransport,
  type BridgeClientTransportError,
} from "./bridge-client-transport";
import {
  type BridgeGateway,
  type BridgeGatewaySession,
  createBridgeGateway,
} from "./gateway";

class FakeGatewaySession implements BridgeGatewaySession {
  readonly id: string;
  onmessage: ((message: BridgeMessage) => void) | undefined;
  onclose: ((reason: BridgeCloseCode | "REMOTE_CLOSE") => void) | undefined;
  readonly sent: BridgeMessage[] = [];
  private _state: BridgeGatewaySession["state"] = "ready";

  constructor(id = "fake-session") {
    this.id = id;
  }

  get state(): BridgeGatewaySession["state"] {
    return this._state;
  }

  async send(message: BridgeMessage): Promise<void> {
    if (this._state !== "ready") throw new Error("session closed");
    this.sent.push(message);
  }

  async close(code: BridgeCloseCode = "NORMAL"): Promise<void> {
    if (this._state === "closed") return;
    this._state = "closed";
    this.onclose?.(code);
  }

  emit(message: BridgeMessage): void {
    this.onmessage?.(message);
  }

  remoteClose(reason: BridgeCloseCode | "REMOTE_CLOSE"): void {
    if (this._state === "closed") return;
    this._state = "closed";
    this.onclose?.(reason);
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

describe("BridgeClientTransport", () => {
  const gateways: BridgeGateway[] = [];
  const localTransports: BridgeServerTransport[] = [];
  const runtimes: Array<ReturnType<typeof createLocalMcpRuntime>> = [];
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await Promise.allSettled(
      runtimes.splice(0).map((runtime) => runtime.close()),
    );
    await Promise.allSettled(
      localTransports.splice(0).map((transport) => transport.close()),
    );
    await Promise.allSettled(
      gateways.splice(0).map((gateway) => gateway.stop()),
    );
  });

  test("binds one ready session and round-trips opaque MCP messages", async () => {
    const session = new FakeGatewaySession("client-session");
    const transport = new BridgeClientTransport(session);
    const received: unknown[] = [];
    transport.onmessage = (message) => received.push(message);

    await transport.start();
    expect(transport.state).toBe("ready");
    expect(transport.mcpRole).toBe("client");
    expect(transport.sessionId).toBe("client-session");

    const request = { jsonrpc: "2.0" as const, id: 1, method: "tools/list" };
    await transport.send(request);
    expect(session.sent).toEqual([{ kind: "mcp.message", payload: request }]);

    const response = {
      jsonrpc: "2.0" as const,
      id: 1,
      result: { tools: [] },
    };
    session.emit({ kind: "mcp.message", payload: response });
    await waitFor(() => received[0]);
    expect(received).toEqual([response]);
  });

  test("rejects send before start and after close, and closes idempotently", async () => {
    const session = new FakeGatewaySession();
    const transport = new BridgeClientTransport(session);

    await expect(
      transport.send({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).rejects.toMatchObject({ code: "HANDSHAKE_REQUIRED" });

    await transport.start();
    let closeCalls = 0;
    transport.onclose = () => {
      closeCalls += 1;
    };
    await Promise.all([transport.close(), transport.close()]);
    expect(transport.state).toBe("closed");
    expect(closeCalls).toBe(1);
    expect(session.onmessage).toBeUndefined();
    expect(session.onclose).toBeUndefined();

    await expect(
      transport.send({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).rejects.toMatchObject({ code: "SESSION_CLOSED" });
  });

  test("does not allow two transports to bind the same active session", async () => {
    const session = new FakeGatewaySession();
    const first = new BridgeClientTransport(session);
    const second = new BridgeClientTransport(session);
    await first.start();

    await expect(second.start()).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    await first.close();
  });

  test("preserves a bounded FIFO queue and rejects overflow", async () => {
    let releaseFirst: (() => void) | undefined;
    const session = new FakeGatewaySession();
    const originalSend = session.send.bind(session);
    let first = true;
    session.send = async (message: BridgeMessage) => {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      await originalSend(message);
    };

    const transport = new BridgeClientTransport(session);
    await transport.start();
    const sends = Array.from({ length: BRIDGE_MAX_QUEUED_MESSAGES }, (_, id) =>
      transport.send({ jsonrpc: "2.0", id, method: "notifications/test" }),
    );
    await Promise.resolve();
    await expect(
      transport.send({
        jsonrpc: "2.0",
        id: "overflow",
        method: "notifications/test",
      }),
    ).rejects.toMatchObject({ code: "BACKPRESSURE" });

    releaseFirst?.();
    await Promise.all(sends);
    const ids = session.sent
      .filter(
        (message): message is Extract<BridgeMessage, { kind: "mcp.message" }> =>
          message.kind === "mcp.message",
      )
      .map((message) => message.payload.id);
    expect(ids).toEqual(
      Array.from({ length: BRIDGE_MAX_QUEUED_MESSAGES }, (_, id) => id),
    );
    await transport.close();
  });

  test("rejects invalid inbound data before forwarding it to MCP", async () => {
    const session = new FakeGatewaySession();
    const transport = new BridgeClientTransport(session);
    const received: unknown[] = [];
    const errors: BridgeClientTransportError[] = [];
    transport.onmessage = (message) => received.push(message);
    transport.onerror = (error) =>
      errors.push(error as BridgeClientTransportError);
    await transport.start();

    session.emit({
      kind: "mcp.message",
      payload: "not-an-object",
    } as unknown as BridgeMessage);
    await waitFor(() => (transport.state === "closed" ? true : undefined));

    expect(received).toEqual([]);
    expect(errors[0]).toMatchObject({ code: "INVALID_MESSAGE" });
  });

  test("propagates remote disconnect so an MCP Client pending request rejects", async () => {
    const session = new FakeGatewaySession();
    const transport = new BridgeClientTransport(session);
    const client = new Client({ name: "pending-test", version: "0.1.0" });
    clients.push(client);

    const connecting = client.connect(transport);
    await waitFor(() =>
      session.sent.some(
        (message) =>
          message.kind === "mcp.message" &&
          message.payload.method === "initialize",
      )
        ? true
        : undefined,
    );
    session.remoteClose("REMOTE_CLOSE");

    await expect(connecting).rejects.toBeDefined();
    expect(transport.state).toBe("closed");
  });

  test("runs MCP initialize, tools/list and tools/call system through the real WebSocket bridge", async () => {
    let resolveSession: ((session: BridgeGatewaySession) => void) | undefined;
    const sessionReady = new Promise<BridgeGatewaySession>((resolve) => {
      resolveSession = resolve;
    });
    const gateway = createBridgeGateway({
      port: 0,
      idleTimeoutMs: 0,
      onSession: (session) => resolveSession?.(session),
    });
    gateways.push(gateway);

    const registry = await WorkspaceRegistry.create([]);
    const runtime = createLocalMcpRuntime(registry);
    runtimes.push(runtime);
    const localTransport = new BridgeServerTransport({
      url: gateway.url,
      sessionId: "m2-client-integration",
    });
    localTransports.push(localTransport);
    const localConnected = runtime.connect(localTransport);
    const session = await sessionReady;
    await localConnected;

    const transport = new BridgeClientTransport(session);
    const client = new Client({
      name: "doctmcp-public-test",
      version: "0.1.0",
    });
    clients.push(client);
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(6);

    const result = await client.callTool({
      name: "system",
      arguments: { action: "info" },
    });
    expect(result).toMatchObject({
      structuredContent: { runtime: { name: "bun" } },
    });

    const invalid = await client
      .callTool({ name: "missing-tool", arguments: {} })
      .then(
        (value) => ({ kind: "result" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
    expect(
      invalid.kind === "error" ||
        (invalid.kind === "result" && invalid.value.isError === true),
    ).toBe(true);
  });
});
