export const PROTOCOL_VERSION = 1 as const;

export interface AgentHello {
  type: "agent.hello";
  protocolVersion: typeof PROTOCOL_VERSION;
  deviceId: string;
  agentVersion: string;
}

export interface Heartbeat {
  type: "heartbeat";
  timestamp: string;
}

export type ProtocolMessage = AgentHello | Heartbeat;
