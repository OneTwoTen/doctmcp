export const PROTOCOL_VERSION = 1 as const;

export interface AgentHello {
  type: "agent.hello";
  protocolVersion: typeof PROTOCOL_VERSION;
  deviceId: string;
  agentVersion: string;
}

export interface CommandRequest {
  type: "command.request";
  commandId: string;
  deviceId: string;
  tool: string;
  arguments: unknown;
  createdAt: string;
}

export interface CommandError {
  code: string;
  message: string;
}

export interface CommandResult {
  type: "command.result";
  commandId: string;
  deviceId: string;
  ok: boolean;
  result?: unknown;
  error?: CommandError;
  completedAt: string;
}

export interface Heartbeat {
  type: "heartbeat";
  timestamp: string;
}

export type ProtocolMessage =
  | AgentHello
  | CommandRequest
  | CommandResult
  | Heartbeat;
