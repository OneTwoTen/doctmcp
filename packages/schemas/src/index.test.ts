import { describe, expect, test } from "bun:test";
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeMessage,
  bridgeMessageSchema,
} from "./index";

describe("schemas", () => {
  test("validates the local-first handshake", () => {
    expect(
      bridgeMessageSchema.parse({
        kind: "bridge.hello",
        bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
        role: "local-agent",
        sessionId: "session-1",
      }),
    ).toMatchObject({ kind: "bridge.hello", role: "local-agent" });
  });

  test("preserves MCP messages as opaque JSON-RPC objects", () => {
    const message: BridgeMessage = {
      kind: "mcp.message",
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    };

    expect(bridgeMessageSchema.parse(message)).toEqual(message);
  });

  test("rejects malformed, wrong-role and unknown bridge messages", () => {
    expect(() => bridgeMessageSchema.parse({ kind: "bridge.hello" })).toThrow();
    expect(() =>
      bridgeMessageSchema.parse({
        kind: "bridge.hello",
        bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
        role: "public-server",
        sessionId: "session-1",
      }),
    ).toThrow();
    expect(() =>
      bridgeMessageSchema.parse({ kind: "command.request" }),
    ).toThrow();
  });
});
