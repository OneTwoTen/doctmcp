import type { Transport } from "@doctmcp/protocol";
import type { BridgeServerTransportOptions } from "./bridge-server-transport";
import type { DeviceCredentialProvider } from "./device-credential-provider";

export interface LocalBridgeBackoffPolicy {
  readonly minDelayMs: number;
  readonly maxDelayMs: number;
  readonly factor: number;
  readonly jitterRatio: number;
  readonly stableReadyMs: number;
}

export const DEFAULT_LOCAL_BRIDGE_BACKOFF_POLICY: LocalBridgeBackoffPolicy =
  Object.freeze({
    minDelayMs: 500,
    maxDelayMs: 30_000,
    factor: 2,
    jitterRatio: 0.2,
    stableReadyMs: 30_000,
  });

export function calculateReconnectDelay(
  _consecutiveFailure: number,
  _policy: LocalBridgeBackoffPolicy,
  _random: () => number,
): number {
  return 0;
}

export type LocalBridgeFailureDisposition =
  | "retry"
  | "auth-failed"
  | "protocol-failed";

export function classifyBridgeFailure(
  _error: unknown,
): LocalBridgeFailureDisposition {
  return "retry";
}

export interface LocalBridgeReconnectScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface LocalBridgeRuntimeConnector {
  connect(transport: Transport): Promise<void>;
}

export type LocalBridgeReconnectState =
  | "idle"
  | "connecting"
  | "ready"
  | "backoff"
  | "pairing-required"
  | "auth-failed"
  | "protocol-failed"
  | "credential-failed"
  | "stopped";

export interface LocalBridgeReconnectSnapshot {
  readonly state: LocalBridgeReconnectState;
  readonly lifecycleGeneration: number;
  readonly attemptGeneration: number;
  readonly consecutiveFailures: number;
  readonly lastFailureCode?: string;
  readonly retryDelayMs?: number;
  readonly deviceId?: string;
}

export type LocalBridgeTransportFactory = (
  options: BridgeServerTransportOptions,
) => Transport;

export interface LocalBridgeReconnectControllerOptions {
  readonly url: string;
  readonly runtime: LocalBridgeRuntimeConnector;
  readonly credentialProvider: DeviceCredentialProvider;
  readonly scheduler?: LocalBridgeReconnectScheduler;
  readonly random?: () => number;
  readonly backoffPolicy?: LocalBridgeBackoffPolicy;
  readonly transportFactory?: LocalBridgeTransportFactory;
}

export class LocalBridgeReconnectController {
  constructor(options: LocalBridgeReconnectControllerOptions) {
    if (!options.url) throw new Error("Bridge URL is required");
  }

  get snapshot(): LocalBridgeReconnectSnapshot {
    return Object.freeze({
      state: "idle",
      lifecycleGeneration: 0,
      attemptGeneration: 0,
      consecutiveFailures: 0,
    });
  }

  start(): void {}

  stop(): Promise<void> {
    return Promise.resolve();
  }
}
