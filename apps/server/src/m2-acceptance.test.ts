import { afterEach, describe, expect, test } from "bun:test";
import {
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_PROTOCOL_VERSION,
} from "@doctmcp/protocol";
import { Client } from "@modelcontextprotocol/client";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeServerTransport } from "../../agent/src/bridge-server-transport";
import { createLocalMcpRuntime } from "../../agent/src/local-mcp-runtime";
import { WorkspaceRegistry } from "../../agent/src/workspace";
import { BridgeClientTransport } from "./bridge-client-transport";
import {
  type BridgeGateway,
  type BridgeGatewaySession,
  createBridgeGateway,
} from "./gateway";

interface ReceivedMessage {
  readonly kind: string;
  readonly [key: string]: unknown;
}

function waitFor<T>(value: () => T | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for M2 acceptance condition")),
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
  predicate: (message: ReceivedMessage) => boolean,
): Promise<ReceivedMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("Timed out waiting for WebSocket message"));
    }, 2_000);

    function onMessage(event: MessageEvent<string | ArrayBuffer>): void {
      const text =
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data);
      const message = JSON.parse(text) as ReceivedMessage;
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

function getText(result: unknown): string {
  if (
    typeof result !== "object" ||
    result === null ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    throw new Error("Expected MCP result content");
  }
  const first = result.content[0];
  if (
    typeof first !== "object" ||
    first === null ||
    !("type" in first) ||
    first.type !== "text" ||
    !("text" in first) ||
    typeof first.text !== "string"
  ) {
    throw new Error("Expected text MCP content");
  }
  return first.text;
}

function getErrorCode(result: unknown): string {
  const parsed = JSON.parse(getText(result)) as { code?: unknown };
  if (typeof parsed.code !== "string") {
    throw new Error("Expected structured MCP error code");
  }
  return parsed.code;
}

async function expectProtocolFailure(call: Promise<unknown>): Promise<void> {
  try {
    const result = (await call) as { isError?: boolean };
    expect(result.isError).toBe(true);
  } catch (error) {
    expect(error).toBeDefined();
  }
}

describe("M2 server-local WebSocket acceptance", () => {
  const roots: string[] = [];
  const gateways: BridgeGateway[] = [];
  const localTransports: BridgeServerTransport[] = [];
  const publicTransports: BridgeClientTransport[] = [];
  const runtimes: Array<ReturnType<typeof createLocalMcpRuntime>> = [];
  const clients: Client[] = [];
  const sockets: WebSocket[] = [];
  let sessionCounter = 0;

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await Promise.allSettled(
      publicTransports.splice(0).map((transport) => transport.close()),
    );
    await Promise.allSettled(
      localTransports.splice(0).map((transport) => transport.close()),
    );
    await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
    await Promise.allSettled(gateways.splice(0).map((gateway) => gateway.stop()));
    await Promise.allSettled(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function setupBridge() {
    const root = await mkdtemp(join(tmpdir(), "doctmcp-m2-acceptance-"));
    roots.push(root);
    await writeFile(join(root, "fixture.txt"), "fixture over m2 bridge\n");

    const registry = await WorkspaceRegistry.create([
      {
        id: "project",
        name: "M2 acceptance project",
        root,
        capabilities: {
          read: true,
          write: true,
          delete: true,
          execute: true,
        },
      },
    ]);

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

    const runtime = createLocalMcpRuntime(registry, {
      shellExec: {
        defaultTimeoutMs: 500,
        maxTimeoutMs: 1_000,
        maxOutputBytes: 1_024,
        killGraceMs: 25,
      },
    });
    runtimes.push(runtime);

    sessionCounter += 1;
    const localTransport = new BridgeServerTransport({
      url: gateway.url,
      sessionId: `m2-acceptance-${sessionCounter}`,
    });
    localTransports.push(localTransport);
    const localConnected = runtime.connect(localTransport);
    const session = await sessionReady;
    await localConnected;

    const publicTransport = new BridgeClientTransport(session);
    publicTransports.push(publicTransport);
    const client = new Client({ name: "doctmcp-m2-acceptance", version: "0.1.0" });
    clients.push(client);
    await client.connect(publicTransport);

    return {
      root,
      gateway,
      runtime,
      localTransport,
      publicTransport,
      client,
    };
  }

  test("initializes and round-trips catalog, system and filesystem calls through the production bridge", async () => {
    const { root, client } = await setupBridge();

    expect(client.getServerVersion()).toMatchObject({
      name: "doctmcp-agent",
      version: "0.1.0",
    });

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
      [
        "filesystem.delete",
        "filesystem.read",
        "filesystem.write",
        "shell.exec",
        "system",
        "workspace",
      ].sort(),
    );

    const system = await client.callTool({
      name: "system",
      arguments: { action: "info" },
    });
    expect(system.isError).toBeFalsy();
    expect(system.structuredContent).toMatchObject({ runtime: { name: "bun" } });

    const write = await client.callTool({
      name: "filesystem.write",
      arguments: {
        action: "write",
        workspace: "project",
        path: "round-trip.txt",
        content: "written through m2\n",
      },
    });
    expect(write.isError).toBeFalsy();
    expect(await readFile(join(root, "round-trip.txt"), "utf8")).toBe(
      "written through m2\n",
    );

    const read = await client.callTool({
      name: "filesystem.read",
      arguments: {
        action: "read",
        workspace: "project",
        path: "round-trip.txt",
      },
    });
    expect(read.isError).toBeFalsy();
    expect(getText(read)).toContain("written through m2");
  });

  test("preserves unknown-tool and domain-error semantics across the bridge", async () => {
    const { client } = await setupBridge();

    await expectProtocolFailure(
      client.callTool({ name: "missing-tool", arguments: {} }),
    );

    const missingWorkspace = await client.callTool({
      name: "workspace",
      arguments: { action: "get", workspace: "missing" },
    });
    expect(missingWorkspace.isError).toBe(true);
    expect(getErrorCode(missingWorkspace)).toBe("WORKSPACE_NOT_FOUND");

    const healthy = await client.callTool({
      name: "system",
      arguments: { action: "info" },
    });
    expect(healthy.isError).toBeFalsy();
  });

  test("rejects a pending public MCP request when the local bridge disconnects", async () => {
    const { client, localTransport, publicTransport } = await setupBridge();

    const pending = client.callTool({
      name: "shell.exec",
      arguments: {
        workspace: "project",
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10_000)"],
        timeoutMs: 1_000,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    await localTransport.close();

    await expect(pending).rejects.toBeDefined();
    await waitFor(() =>
      publicTransport.state === "closed" ? true : undefined,
    );
  });

  test("public close propagates to local and cleanup stays idempotent", async () => {
    const { gateway, localTransport, publicTransport } = await setupBridge();

    await Promise.all([publicTransport.close(), publicTransport.close()]);
    await waitFor(() =>
      localTransport.state === "closed" ? true : undefined,
    );

    expect(gateway.sessionCount).toBe(0);
    await expect(publicTransport.close()).resolves.toBeUndefined();
    await expect(gateway.stop()).resolves.toBeUndefined();
    await expect(gateway.stop()).resolves.toBeUndefined();
  });

  test("malformed frame is rejected deterministically by the production gateway", async () => {
    const gateway = createBridgeGateway({ port: 0 });
    gateways.push(gateway);
    const socket = new WebSocket(gateway.url);
    sockets.push(socket);
    await waitForOpen(socket);
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

    expect(error).toMatchObject({ kind: "bridge.error", code: "INVALID_MESSAGE" });
    expect(closeFrame).toEqual({
      kind: "bridge.close",
      code: "PROTOCOL_ERROR",
    });
    expect((await closePromise).code).toBe(1002);
    expect(gateway.sessionCount).toBe(0);
  });

  test("oversized UTF-8 frame is rejected before bridge parsing", async () => {
    const gateway = createBridgeGateway({ port: 0 });
    gateways.push(gateway);
    const socket = new WebSocket(gateway.url);
    sockets.push(socket);
    await waitForOpen(socket);
    const closePromise = waitForClose(socket);

    socket.send(
      JSON.stringify({
        kind: "bridge.hello",
        bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
        role: "local-agent",
        sessionId: "x".repeat(BRIDGE_MAX_MESSAGE_BYTES),
      }),
    );
    const error = await waitForMessage(
      socket,
      (message) => message.kind === "bridge.error",
    );

    expect(error).toMatchObject({
      kind: "bridge.error",
      code: "MESSAGE_TOO_LARGE",
    });
    expect((await closePromise).code).toBe(1002);
    expect(gateway.sessionCount).toBe(0);
  });
});
