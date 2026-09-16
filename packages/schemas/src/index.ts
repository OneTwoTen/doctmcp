import { z } from "zod";
import { deviceCredentialSecretSchema } from "./device-credential";
import { deviceIdSchema } from "./device";

export * from "./device";
export * from "./device-credential";
export * from "./pairing";

/** Phiên bản control-plane của bridge, độc lập với MCP protocol version. */
export const BRIDGE_PROTOCOL_VERSION = "1" as const;
export const BRIDGE_MAX_MESSAGE_BYTES = 1_048_576 as const;
export const BRIDGE_MAX_QUEUED_MESSAGES = 256 as const;
export const BRIDGE_MAX_QUEUED_BYTES = 4_194_304 as const;

export const bridgeRoleSchema = z.enum(["local-agent", "public-server"]);

export const bridgeDeviceAuthSchema = z
  .object({
    mode: z.literal("device"),
    deviceId: deviceIdSchema,
    credential: deviceCredentialSecretSchema,
  })
  .strict();

export const bridgeHelloSchema = z
  .object({
    kind: z.literal("bridge.hello"),
    bridgeProtocolVersion: z.string().min(1),
    role: z.literal("local-agent"),
    sessionId: z.string().min(1),
    auth: bridgeDeviceAuthSchema.optional(),
  })
  .strict();

export const bridgeHelloAckSchema = z
  .object({
    kind: z.literal("bridge.hello.ack"),
    bridgeProtocolVersion: z.string().min(1),
    role: z.literal("public-server"),
    sessionId: z.string().min(1),
  })
  .strict();

/**
 * MCP JSON-RPC message được chuyển nguyên dạng trong payload.
 * Bridge không parse hoặc tái định nghĩa tool, arguments hay result.
 */
export const bridgeMcpMessageSchema = z
  .object({
    kind: z.literal("mcp.message"),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export const bridgeErrorCodeSchema = z.enum([
  "INVALID_MESSAGE",
  "MESSAGE_TOO_LARGE",
  "UNSUPPORTED_VERSION",
  "HANDSHAKE_REQUIRED",
  "UNEXPECTED_MESSAGE",
  "SESSION_CLOSED",
  "TIMEOUT",
  "BACKPRESSURE",
  "AUTH_REQUIRED",
  "AUTH_FAILED",
]);

export const bridgeErrorSchema = z
  .object({
    kind: z.literal("bridge.error"),
    code: bridgeErrorCodeSchema,
    message: z.string().min(1).max(500),
  })
  .strict();

export const bridgeCloseCodeSchema = z.enum([
  "NORMAL",
  "PROTOCOL_ERROR",
  "TIMEOUT",
  "SERVER_SHUTDOWN",
]);

export const bridgeCloseSchema = z
  .object({
    kind: z.literal("bridge.close"),
    code: bridgeCloseCodeSchema,
  })
  .strict();

export const bridgeMessageSchema = z.discriminatedUnion("kind", [
  bridgeHelloSchema,
  bridgeHelloAckSchema,
  bridgeMcpMessageSchema,
  bridgeErrorSchema,
  bridgeCloseSchema,
]);

export type BridgeRole = z.infer<typeof bridgeRoleSchema>;
export type BridgeDeviceAuth = z.infer<typeof bridgeDeviceAuthSchema>;
export type BridgeHello = z.infer<typeof bridgeHelloSchema>;
export type BridgeHelloAck = z.infer<typeof bridgeHelloAckSchema>;
export type BridgeMcpMessage = z.infer<typeof bridgeMcpMessageSchema>;
export type BridgeError = z.infer<typeof bridgeErrorSchema>;
export type BridgeErrorCode = z.infer<typeof bridgeErrorCodeSchema>;
export type BridgeClose = z.infer<typeof bridgeCloseSchema>;
export type BridgeCloseCode = z.infer<typeof bridgeCloseCodeSchema>;
export type BridgeMessage = z.infer<typeof bridgeMessageSchema>;
