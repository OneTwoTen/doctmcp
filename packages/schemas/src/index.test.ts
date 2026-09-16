import { describe, expect, test } from "bun:test";
import {
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_QUEUED_BYTES,
  BRIDGE_MAX_QUEUED_MESSAGES,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeMessage,
  bridgeMessageSchema,
  DEVICE_CREDENTIAL_SECRET_BASE64URL_LENGTH,
} from "./index";

const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VALID_CREDENTIAL = "A".repeat(DEVICE_CREDENTIAL_SECRET_BASE64URL_LENGTH);

describe("schemas", () => {
  test("exposes deterministic bridge size and queue limits", () => {
    expect(BRIDGE_MAX_MESSAGE_BYTES).toBe(1_048_576);
    expect(BRIDGE_MAX_QUEUED_MESSAGES).toBe(256);
    expect(BRIDGE_MAX_QUEUED_BYTES).toBe(4_194_304);
  });

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

  test("locks authenticated hello to UUID v4 device id and 256-bit unpadded base64url credential", () => {
    expect(
      bridgeMessageSchema.parse({
        kind: "bridge.hello",
        bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
        role: "local-agent",
        sessionId: "session-auth",
        auth: {
          mode: "device",
          deviceId: DEVICE_ID.toUpperCase(),
          credential: VALID_CREDENTIAL,
        },
      }),
    ).toMatchObject({
      auth: { deviceId: DEVICE_ID, credential: VALID_CREDENTIAL },
    });

    for (const credential of [
      "short-secret",
      `${"A".repeat(42)}=`,
      `${"A".repeat(42)}+`,
      "A".repeat(44),
    ]) {
      expect(() =>
        bridgeMessageSchema.parse({
          kind: "bridge.hello",
          bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
          role: "local-agent",
          sessionId: "session-auth",
          auth: { mode: "device", deviceId: DEVICE_ID, credential },
        }),
      ).toThrow();
    }
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
