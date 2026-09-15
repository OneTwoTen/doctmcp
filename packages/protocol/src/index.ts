// Re-export contract ở protocol package để các lớp bridge không phải biết schema nội bộ.

export type {
  BridgeClose,
  BridgeError,
  BridgeHello,
  BridgeHelloAck,
  BridgeMcpMessage,
  BridgeMessage,
  BridgeRole,
} from "@doctmcp/schemas";
export {
  BRIDGE_PROTOCOL_VERSION,
  bridgeCloseCodeSchema,
  bridgeCloseSchema,
  bridgeErrorCodeSchema,
  bridgeErrorSchema,
  bridgeHelloAckSchema,
  bridgeHelloSchema,
  bridgeMcpMessageSchema,
  bridgeMessageSchema,
  bridgeRoleSchema,
} from "@doctmcp/schemas";
