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
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_QUEUED_BYTES,
  BRIDGE_MAX_QUEUED_MESSAGES,
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

import type {
  JSONRPCMessage,
  MessageExtraInfo,
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/client";

export type {
  JSONRPCMessage,
  MessageExtraInfo,
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/client";

export type BridgeTransportState =
  | "idle"
  | "connecting"
  | "handshaking"
  | "ready"
  | "closing"
  | "closed"
  | "failed";

/** Contract chung cho BridgeClientTransport và BridgeServerTransport. */
export interface BridgeTransportContract extends Transport {
  readonly state: BridgeTransportState;
  readonly maxMessageBytes: number;
  readonly maxQueuedMessages: number;
  readonly maxQueuedBytes: number;
  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
}

export interface BridgeClientTransportContract extends BridgeTransportContract {
  readonly direction: "local-to-public";
}

export interface BridgeServerTransportContract extends BridgeTransportContract {
  readonly direction: "public-to-local";
}
