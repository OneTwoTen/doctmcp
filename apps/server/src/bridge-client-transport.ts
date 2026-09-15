import {
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_QUEUED_BYTES,
  BRIDGE_MAX_QUEUED_MESSAGES,
  type BridgeClientTransportContract,
  type BridgeErrorCode,
  type BridgeMessage,
  bridgeMessageSchema,
  type JSONRPCMessage,
  type MessageExtraInfo,
  type TransportSendOptions,
} from "@doctmcp/protocol";
import { BridgeGatewayError, type BridgeGatewaySession } from "./gateway";

export type BridgeClientTransportErrorCode = BridgeErrorCode | "INVALID_STATE";

export class BridgeClientTransportError extends Error {
  readonly code: BridgeClientTransportErrorCode;

  constructor(code: BridgeClientTransportErrorCode, message: string) {
    super(message);
    this.name = "BridgeClientTransportError";
    this.code = code;
  }
}

interface QueuedMessage {
  readonly message: BridgeMessage;
  readonly bytes: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

function normalizeError(
  error: unknown,
  fallback = "Bridge session failed",
): BridgeClientTransportError {
  if (error instanceof BridgeClientTransportError) return error;
  if (error instanceof BridgeGatewayError) {
    return new BridgeClientTransportError(error.code, error.message);
  }
  return new BridgeClientTransportError(
    "SESSION_CLOSED",
    error instanceof Error && error.message ? error.message : fallback,
  );
}

function serializeMcpMessage(message: JSONRPCMessage): {
  message: BridgeMessage;
  bytes: number;
} {
  const parsed = bridgeMessageSchema.safeParse({
    kind: "mcp.message",
    payload: message,
  });
  if (!parsed.success) {
    throw new BridgeClientTransportError(
      "INVALID_MESSAGE",
      "Cannot send an invalid MCP bridge message",
    );
  }

  let text: string;
  try {
    text = JSON.stringify(parsed.data);
  } catch {
    throw new BridgeClientTransportError(
      "INVALID_MESSAGE",
      "MCP bridge message is not JSON serializable",
    );
  }
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > BRIDGE_MAX_MESSAGE_BYTES) {
    throw new BridgeClientTransportError(
      "MESSAGE_TOO_LARGE",
      "Bridge message exceeds the maximum size",
    );
  }
  return { message: parsed.data, bytes };
}

/** MCP client-side transport bound to one ready public gateway session. */
export class BridgeClientTransport implements BridgeClientTransportContract {
  readonly mcpRole = "client" as const;
  readonly maxMessageBytes = BRIDGE_MAX_MESSAGE_BYTES;
  readonly maxQueuedMessages = BRIDGE_MAX_QUEUED_MESSAGES;
  readonly maxQueuedBytes = BRIDGE_MAX_QUEUED_BYTES;
  readonly sessionId: string;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  private readonly session: BridgeGatewaySession;
  private _state: BridgeClientTransportContract["state"] = "idle";
  private queue: QueuedMessage[] = [];
  private queuedBytes = 0;
  private drainScheduled = false;
  private draining = false;
  private callbackClosed = false;
  private errorReported = false;
  private intentionalClose = false;
  private incomingChain: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> = Promise.resolve();

  constructor(session: BridgeGatewaySession) {
    this.session = session;
    this.sessionId = session.id;
  }

  get state(): BridgeClientTransportContract["state"] {
    return this._state;
  }

  async start(): Promise<void> {
    if (this._state !== "idle") {
      throw new BridgeClientTransportError(
        "INVALID_STATE",
        "Bridge client transport can only be started once",
      );
    }
    if (this.session.state !== "ready") {
      this._state = "failed";
      throw new BridgeClientTransportError(
        "SESSION_CLOSED",
        "Bridge gateway session is not ready",
      );
    }
    if (this.session.onmessage || this.session.onclose) {
      this._state = "failed";
      throw new BridgeClientTransportError(
        "INVALID_STATE",
        "Bridge gateway session is already bound",
      );
    }

    this._state = "connecting";
    this.session.onmessage = this.handleSessionMessage;
    this.session.onclose = this.handleSessionClose;
    if (this.session.state !== "ready") {
      this.detachSessionCallbacks();
      this._state = "failed";
      throw new BridgeClientTransportError(
        "SESSION_CLOSED",
        "Bridge gateway session closed while binding",
      );
    }
    this._state = "ready";
  }

  send(
    message: JSONRPCMessage,
    _options?: TransportSendOptions,
  ): Promise<void> {
    if (this._state !== "ready") {
      return Promise.reject(
        new BridgeClientTransportError(
          this._state === "idle" || this._state === "connecting"
            ? "HANDSHAKE_REQUIRED"
            : "SESSION_CLOSED",
          "Bridge client transport is not ready",
        ),
      );
    }

    let frame: { message: BridgeMessage; bytes: number };
    try {
      frame = serializeMcpMessage(message);
    } catch (error) {
      return Promise.reject(error);
    }

    if (
      this.queue.length >= this.maxQueuedMessages ||
      this.queuedBytes + frame.bytes > this.maxQueuedBytes
    ) {
      return Promise.reject(
        new BridgeClientTransportError(
          "BACKPRESSURE",
          "Bridge client transport queue is full",
        ),
      );
    }

    return new Promise<void>((resolve, reject) => {
      this.queue.push({
        message: frame.message,
        bytes: frame.bytes,
        resolve,
        reject,
      });
      this.queuedBytes += frame.bytes;
      this.scheduleDrain();
    });
  }

  close(): Promise<void> {
    if (this._state === "closed" || this._state === "closing") {
      return this.closePromise;
    }

    this.intentionalClose = true;
    this._state = "closing";
    this.rejectQueued(
      new BridgeClientTransportError(
        "SESSION_CLOSED",
        "Bridge client transport is closed",
      ),
    );

    this.closePromise = (async () => {
      try {
        if (this.session.state === "ready") {
          await this.session.close("NORMAL");
        }
      } catch (error) {
        this.reportError(normalizeError(error, "Failed to close bridge session"));
      } finally {
        this.finalizeClose();
      }
    })();
    return this.closePromise;
  }

  private readonly handleSessionMessage = (message: BridgeMessage): void => {
    this.incomingChain = this.incomingChain
      .then(() => this.handleIncomingMessage(message))
      .catch((error: unknown) => {
        this.fail(normalizeError(error, "Failed to process bridge message"));
      });
  };

  private readonly handleSessionClose = (
    reason: Parameters<NonNullable<BridgeGatewaySession["onclose"]>>[0],
  ): void => {
    if (this._state === "closed") return;
    if (!this.intentionalClose && reason !== "NORMAL") {
      this.reportError(
        new BridgeClientTransportError(
          "SESSION_CLOSED",
          `Bridge gateway session closed: ${reason}`,
        ),
      );
    }
    this.finalizeClose();
  };

  private handleIncomingMessage(message: BridgeMessage): void {
    if (this._state !== "ready") return;
    const parsed = bridgeMessageSchema.safeParse(message);
    if (!parsed.success) {
      throw new BridgeClientTransportError(
        "INVALID_MESSAGE",
        "Bridge gateway delivered an invalid message",
      );
    }
    if (parsed.data.kind !== "mcp.message") {
      throw new BridgeClientTransportError(
        "UNEXPECTED_MESSAGE",
        "Bridge client transport only accepts MCP messages",
      );
    }

    const bytes = new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength;
    if (bytes > this.maxMessageBytes) {
      throw new BridgeClientTransportError(
        "MESSAGE_TOO_LARGE",
        "Bridge message exceeds the maximum size",
      );
    }

    try {
      this.onmessage?.(parsed.data.payload as JSONRPCMessage);
    } catch (error) {
      throw normalizeError(error, "MCP client callback failed");
    }
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.draining) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      void this.drainQueue();
    });
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this._state === "ready") {
        const item = this.queue[0];
        if (!item) break;
        try {
          await this.session.send(item.message);
        } catch (error) {
          const sendError = normalizeError(error, "Failed to send MCP message");
          if (this.queue[0] === item) {
            this.queue.shift();
            this.queuedBytes -= item.bytes;
          }
          item.reject(sendError);
          this.fail(sendError);
          break;
        }
        if (this.queue[0] === item) {
          this.queue.shift();
          this.queuedBytes -= item.bytes;
        }
        item.resolve();
      }
    } finally {
      this.draining = false;
    }
  }

  private fail(error: BridgeClientTransportError): void {
    if (this._state === "closed" || this._state === "closing") return;
    this._state = "failed";
    this.rejectQueued(error);
    this.reportError(error);
    void this.session.close("PROTOCOL_ERROR").catch(() => undefined);
    this.finalizeClose();
  }

  private reportError(error: Error): void {
    if (this.errorReported) return;
    this.errorReported = true;
    try {
      this.onerror?.(error);
    } catch {
      // Consumer callbacks must not break transport cleanup.
    }
  }

  private rejectQueued(error: Error): void {
    const queued = this.queue.splice(0);
    this.queuedBytes = 0;
    for (const item of queued) item.reject(error);
  }

  private finalizeClose(): void {
    if (this._state === "closed") return;
    this.detachSessionCallbacks();
    this.rejectQueued(
      new BridgeClientTransportError(
        "SESSION_CLOSED",
        "Bridge client transport is closed",
      ),
    );
    this._state = "closed";
    if (!this.callbackClosed) {
      this.callbackClosed = true;
      try {
        this.onclose?.();
      } catch {
        // Consumer callbacks must not break transport cleanup.
      }
    }
  }

  private detachSessionCallbacks(): void {
    if (this.session.onmessage === this.handleSessionMessage) {
      this.session.onmessage = undefined;
    }
    if (this.session.onclose === this.handleSessionClose) {
      this.session.onclose = undefined;
    }
  }
}
