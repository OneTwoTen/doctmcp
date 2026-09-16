import { afterEach, describe, expect, test } from "bun:test";
import { BRIDGE_PROTOCOL_VERSION } from "@doctmcp/protocol";
import { type BridgeGateway, createBridgeGateway } from "./gateway";

const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CREDENTIAL = "A".repeat(43);

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

function waitForAck(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for bridge ACK")),
      2_000,
    );
    socket.addEventListener("message", function onMessage(event) {
      const data =
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer);
      const message = JSON.parse(data) as { kind?: string };
      if (message.kind !== "bridge.hello.ack") return;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve();
    });
  });
}

function waitForClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for heartbeat close")),
      2_000,
    );
    socket.addEventListener(
      "close",
      (event) => {
        clearTimeout(timeout);
        resolve(event);
      },
      { once: true },
    );
  });
}

describe("BridgeGateway authenticated heartbeat", () => {
  let gateway: BridgeGateway | null = null;
  let socket: WebSocket | null = null;

  afterEach(async () => {
    socket?.close();
    await gateway?.stop();
    socket = null;
    gateway = null;
  });

  test("MCP traffic cannot keep a session alive when heartbeat validation stops completing", async () => {
    gateway = createBridgeGateway({
      port: 0,
      idleTimeoutMs: 1_000,
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 60,
      authenticateDevice: async () => ({
        ownerId: "owner-a",
        deviceId: DEVICE_ID,
      }),
      onHeartbeat: () => new Promise<void>(() => undefined),
    });
    socket = new WebSocket(gateway.url);
    await waitForOpen(socket);
    const ackPromise = waitForAck(socket);
    socket.send(
      JSON.stringify({
        kind: "bridge.hello",
        bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
        role: "local-agent",
        sessionId: "heartbeat-timeout-session",
        auth: {
          mode: "device",
          deviceId: DEVICE_ID,
          credential: CREDENTIAL,
        },
      }),
    );
    await ackPromise;

    const closePromise = waitForClose(socket);
    const mcpTraffic = setInterval(() => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send(
        JSON.stringify({
          kind: "mcp.message",
          message: {
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { progressToken: "test", progress: 1 },
          },
        }),
      );
    }, 5);

    const close = await closePromise;
    clearInterval(mcpTraffic);

    expect(close.code).toBe(1001);
    expect(gateway.sessionCount).toBe(0);
  });
});
