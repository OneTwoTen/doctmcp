import type { Transport } from "@doctmcp/protocol";
import {
  BridgeServerTransport,
  BridgeServerTransportError,
  type BridgeServerTransportOptions,
} from "./bridge-server-transport";
import {
  type DeviceCredentialProvider,
  type LocalDeviceCredential,
  LocalDeviceCredentialProviderError,
} from "./device-credential-provider";

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

function validateBackoffPolicy(
  policy: LocalBridgeBackoffPolicy,
): LocalBridgeBackoffPolicy {
  if (
    !Number.isFinite(policy.minDelayMs) ||
    policy.minDelayMs <= 0 ||
    !Number.isFinite(policy.maxDelayMs) ||
    policy.maxDelayMs < policy.minDelayMs ||
    !Number.isFinite(policy.factor) ||
    policy.factor < 1 ||
    !Number.isFinite(policy.jitterRatio) ||
    policy.jitterRatio < 0 ||
    policy.jitterRatio > 1 ||
    !Number.isFinite(policy.stableReadyMs) ||
    policy.stableReadyMs < 0
  ) {
    throw new Error("Local bridge backoff policy không hợp lệ.");
  }
  return Object.freeze({ ...policy });
}

export function calculateReconnectDelay(
  consecutiveFailure: number,
  policy: LocalBridgeBackoffPolicy,
  random: () => number,
): number {
  const validated = validateBackoffPolicy(policy);
  if (!Number.isInteger(consecutiveFailure) || consecutiveFailure <= 0) {
    throw new Error("Reconnect failure counter phải là số nguyên dương.");
  }

  const exponential =
    validated.minDelayMs * validated.factor ** (consecutiveFailure - 1);
  const base = Math.min(validated.maxDelayMs, exponential);
  const randomValue = random();
  const normalizedRandom = Number.isFinite(randomValue)
    ? Math.min(1, Math.max(0, randomValue))
    : 0.5;
  const multiplier = 1 + (normalizedRandom * 2 - 1) * validated.jitterRatio;
  return Math.min(
    validated.maxDelayMs,
    Math.max(validated.minDelayMs, Math.round(base * multiplier)),
  );
}

export type LocalBridgeFailureDisposition =
  | "retry"
  | "auth-failed"
  | "protocol-failed";

export function classifyBridgeFailure(
  error: unknown,
): LocalBridgeFailureDisposition {
  if (!(error instanceof BridgeServerTransportError)) return "retry";

  switch (error.code) {
    case "AUTH_FAILED":
    case "AUTH_REQUIRED":
      return "auth-failed";
    case "SOCKET_ERROR":
    case "SESSION_CLOSED":
    case "TIMEOUT":
      return "retry";
    case "INVALID_MESSAGE":
    case "MESSAGE_TOO_LARGE":
    case "UNSUPPORTED_VERSION":
    case "HANDSHAKE_REQUIRED":
    case "UNEXPECTED_MESSAGE":
    case "BACKPRESSURE":
    case "INVALID_STATE":
      return "protocol-failed";
  }
}

export interface LocalBridgeReconnectScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultScheduler: LocalBridgeReconnectScheduler = Object.freeze({
  setTimeout: (callback: () => void, delayMs: number): unknown =>
    globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle: unknown): void => {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});

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

export type LocalBridgeReconnectLogger = (
  event: string,
  details?: Readonly<Record<string, string>>,
) => void;

export interface LocalBridgeReconnectControllerOptions {
  readonly url: string;
  readonly runtime: LocalBridgeRuntimeConnector;
  readonly credentialProvider: DeviceCredentialProvider;
  readonly scheduler?: LocalBridgeReconnectScheduler;
  readonly random?: () => number;
  readonly backoffPolicy?: LocalBridgeBackoffPolicy;
  readonly transportFactory?: LocalBridgeTransportFactory;
  readonly logger?: LocalBridgeReconnectLogger;
}

interface ActiveBridgeAttempt {
  readonly lifecycleGeneration: number;
  readonly attemptGeneration: number;
  readonly transport: Transport;
  failure?: unknown;
  finalized: boolean;
}

function failureCode(error: unknown): string {
  if (error instanceof BridgeServerTransportError) return error.code;
  if (error instanceof LocalDeviceCredentialProviderError) return error.code;
  return "UNKNOWN";
}

function failureForUnexpectedClose(): BridgeServerTransportError {
  return new BridgeServerTransportError(
    "SESSION_CLOSED",
    "Bridge transport closed before local reconnect controller stopped it",
  );
}

export class LocalBridgeReconnectController {
  readonly #url: string;
  readonly #runtime: LocalBridgeRuntimeConnector;
  readonly #credentialProvider: DeviceCredentialProvider;
  readonly #scheduler: LocalBridgeReconnectScheduler;
  readonly #random: () => number;
  readonly #backoffPolicy: LocalBridgeBackoffPolicy;
  readonly #transportFactory: LocalBridgeTransportFactory;
  readonly #logger: LocalBridgeReconnectLogger | undefined;

  #state: LocalBridgeReconnectState = "idle";
  #lifecycleGeneration = 0;
  #attemptGeneration = 0;
  #consecutiveFailures = 0;
  #lastFailureCode: string | undefined;
  #retryDelayMs: number | undefined;
  #deviceId: string | undefined;
  #currentAttempt: ActiveBridgeAttempt | null = null;
  #backoffTimer: unknown | null = null;
  #stableReadyTimer: unknown | null = null;

  constructor(options: LocalBridgeReconnectControllerOptions) {
    if (!options.url) throw new Error("Bridge URL is required");
    this.#url = options.url;
    this.#runtime = options.runtime;
    this.#credentialProvider = options.credentialProvider;
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#random = options.random ?? Math.random;
    this.#backoffPolicy = validateBackoffPolicy(
      options.backoffPolicy ?? DEFAULT_LOCAL_BRIDGE_BACKOFF_POLICY,
    );
    this.#transportFactory =
      options.transportFactory ??
      ((transportOptions) => new BridgeServerTransport(transportOptions));
    this.#logger = options.logger;
  }

  get snapshot(): LocalBridgeReconnectSnapshot {
    return Object.freeze({
      state: this.#state,
      lifecycleGeneration: this.#lifecycleGeneration,
      attemptGeneration: this.#attemptGeneration,
      consecutiveFailures: this.#consecutiveFailures,
      ...(this.#lastFailureCode !== undefined
        ? { lastFailureCode: this.#lastFailureCode }
        : {}),
      ...(this.#retryDelayMs !== undefined
        ? { retryDelayMs: this.#retryDelayMs }
        : {}),
      ...(this.#deviceId !== undefined ? { deviceId: this.#deviceId } : {}),
    });
  }

  start(): void {
    if (
      this.#state === "connecting" ||
      this.#state === "ready" ||
      this.#state === "backoff"
    ) {
      return;
    }

    this.#clearBackoffTimer();
    this.#clearStableReadyTimer();
    this.#lifecycleGeneration += 1;
    this.#attemptGeneration = 0;
    this.#consecutiveFailures = 0;
    this.#lastFailureCode = undefined;
    this.#retryDelayMs = undefined;
    this.#deviceId = undefined;
    const lifecycleGeneration = this.#lifecycleGeneration;
    void this.#startAttempt(lifecycleGeneration);
  }

  async stop(): Promise<void> {
    if (this.#state === "stopped") return;

    this.#lifecycleGeneration += 1;
    this.#clearBackoffTimer();
    this.#clearStableReadyTimer();
    this.#retryDelayMs = undefined;

    const attempt = this.#currentAttempt;
    this.#currentAttempt = null;
    if (attempt) attempt.finalized = true;
    this.#setState("stopped");

    if (attempt) {
      await attempt.transport.close().catch(() => undefined);
    }
  }

  async #startAttempt(lifecycleGeneration: number): Promise<void> {
    if (!this.#isCurrentLifecycle(lifecycleGeneration)) return;
    this.#retryDelayMs = undefined;
    this.#setState("connecting");

    let credential: LocalDeviceCredential | null;
    try {
      credential = await this.#credentialProvider.load();
    } catch (error) {
      if (!this.#isCurrentLifecycle(lifecycleGeneration)) return;
      this.#lastFailureCode =
        error instanceof LocalDeviceCredentialProviderError
          ? error.code
          : "CREDENTIAL_STORAGE_FAILED";
      this.#setState("credential-failed");
      return;
    }

    if (!this.#isCurrentLifecycle(lifecycleGeneration)) return;
    if (!credential) {
      this.#lastFailureCode = "CREDENTIAL_MISSING";
      this.#setState("pairing-required");
      return;
    }
    this.#deviceId = credential.deviceId;

    const attemptGeneration = this.#attemptGeneration + 1;
    this.#attemptGeneration = attemptGeneration;

    let transport: Transport;
    try {
      transport = this.#transportFactory({
        url: this.#url,
        auth: {
          deviceId: credential.deviceId,
          credential: credential.credential,
        },
      });
    } catch (error) {
      await this.#transitionAfterFailure(lifecycleGeneration, error);
      return;
    }

    const attempt: ActiveBridgeAttempt = {
      lifecycleGeneration,
      attemptGeneration,
      transport,
      finalized: false,
    };
    this.#currentAttempt = attempt;

    transport.onerror = (error) => {
      if (!this.#isCurrentAttempt(attempt)) return;
      attempt.failure = error;
      this.#log("bridge.reconnect.failure-observed", {
        failureCode: failureCode(error),
        attemptGeneration: String(attempt.attemptGeneration),
      });
    };
    transport.onclose = () => {
      if (!this.#isCurrentAttempt(attempt)) return;
      void this.#finalizeAttempt(
        attempt,
        attempt.failure ?? failureForUnexpectedClose(),
        true,
      );
    };

    try {
      await this.#runtime.connect(transport);
    } catch (error) {
      await this.#finalizeAttempt(attempt, attempt.failure ?? error, false);
      return;
    }

    if (!this.#isCurrentAttempt(attempt)) return;
    this.#lastFailureCode = undefined;
    this.#retryDelayMs = undefined;
    this.#setState("ready");
    this.#scheduleStableReadyReset(attempt);
  }

  async #finalizeAttempt(
    attempt: ActiveBridgeAttempt,
    error: unknown,
    alreadyClosed: boolean,
  ): Promise<void> {
    if (!this.#isCurrentAttempt(attempt)) return;
    attempt.finalized = true;
    this.#currentAttempt = null;
    this.#clearStableReadyTimer();

    if (!alreadyClosed) {
      await attempt.transport.close().catch(() => undefined);
    }
    if (!this.#isCurrentLifecycle(attempt.lifecycleGeneration)) return;

    await this.#transitionAfterFailure(attempt.lifecycleGeneration, error);
  }

  async #transitionAfterFailure(
    lifecycleGeneration: number,
    error: unknown,
  ): Promise<void> {
    if (!this.#isCurrentLifecycle(lifecycleGeneration)) return;
    const disposition = classifyBridgeFailure(error);
    this.#lastFailureCode = failureCode(error);
    this.#retryDelayMs = undefined;

    if (disposition === "auth-failed") {
      this.#setState("auth-failed");
      return;
    }
    if (disposition === "protocol-failed") {
      this.#setState("protocol-failed");
      return;
    }

    this.#consecutiveFailures += 1;
    const delayMs = calculateReconnectDelay(
      this.#consecutiveFailures,
      this.#backoffPolicy,
      this.#random,
    );
    this.#retryDelayMs = delayMs;
    this.#setState("backoff");
    this.#scheduleBackoff(lifecycleGeneration, delayMs);
  }

  #scheduleBackoff(lifecycleGeneration: number, delayMs: number): void {
    this.#clearBackoffTimer();
    let handle: unknown;
    handle = this.#scheduler.setTimeout(() => {
      if (this.#backoffTimer !== handle) return;
      this.#backoffTimer = null;
      if (
        !this.#isCurrentLifecycle(lifecycleGeneration) ||
        this.#state !== "backoff"
      ) {
        return;
      }
      void this.#startAttempt(lifecycleGeneration);
    }, delayMs);
    this.#backoffTimer = handle;
  }

  #scheduleStableReadyReset(attempt: ActiveBridgeAttempt): void {
    this.#clearStableReadyTimer();
    if (this.#backoffPolicy.stableReadyMs === 0) {
      this.#resetFailuresIfCurrent(attempt);
      return;
    }

    let handle: unknown;
    handle = this.#scheduler.setTimeout(() => {
      if (this.#stableReadyTimer !== handle) return;
      this.#stableReadyTimer = null;
      this.#resetFailuresIfCurrent(attempt);
    }, this.#backoffPolicy.stableReadyMs);
    this.#stableReadyTimer = handle;
  }

  #resetFailuresIfCurrent(attempt: ActiveBridgeAttempt): void {
    if (!this.#isCurrentAttempt(attempt) || this.#state !== "ready") return;
    this.#consecutiveFailures = 0;
    this.#lastFailureCode = undefined;
    this.#log("bridge.reconnect.stable", {
      attemptGeneration: String(attempt.attemptGeneration),
    });
  }

  #isCurrentLifecycle(lifecycleGeneration: number): boolean {
    return lifecycleGeneration === this.#lifecycleGeneration;
  }

  #isCurrentAttempt(attempt: ActiveBridgeAttempt): boolean {
    return (
      !attempt.finalized &&
      attempt.lifecycleGeneration === this.#lifecycleGeneration &&
      this.#currentAttempt === attempt
    );
  }

  #clearBackoffTimer(): void {
    if (this.#backoffTimer === null) return;
    this.#scheduler.clearTimeout(this.#backoffTimer);
    this.#backoffTimer = null;
  }

  #clearStableReadyTimer(): void {
    if (this.#stableReadyTimer === null) return;
    this.#scheduler.clearTimeout(this.#stableReadyTimer);
    this.#stableReadyTimer = null;
  }

  #setState(state: LocalBridgeReconnectState): void {
    this.#state = state;
    this.#log("bridge.reconnect.state", {
      state,
      lifecycleGeneration: String(this.#lifecycleGeneration),
      attemptGeneration: String(this.#attemptGeneration),
    });
  }

  #log(event: string, details: Readonly<Record<string, string>>): void {
    const safeDetails: Record<string, string> = { ...details };
    if (this.#deviceId !== undefined) safeDetails.deviceId = this.#deviceId;
    this.#logger?.(event, Object.freeze(safeDetails));
  }
}
