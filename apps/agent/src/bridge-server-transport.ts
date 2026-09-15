import {
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_QUEUED_BYTES,
  BRIDGE_MAX_QUEUED_MESSAGES,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeCloseCode,
  type BridgeErrorCode,
  type BridgeMessage,
  type BridgeServerTransportContract,
  bridgeMessageSchema,
} from "@doctmcp/protocol";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
  TransportSendOptions,
} from "@modelcontextprotocol/client";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const NATIVE_DRAIN_POLL_MS = 5;
const WEBSOCKET_PROTOCOL_ERROR = 1002;

export type BridgeServerTransportErrorCode =
  | BridgeErrorCode
  | "INVALID_STATE"
  | "SOCKET_ERROR";

export class BridgeServerTransportError extends Error {
  readonly code: BridgeServerTransportErrorCode;

  constructor(code: BridgeServerTransportErrorCode, message: string) {
    super(message);
    this.name = "BridgeServerTransportError";
    this.code = code;
  }
}

export type BridgeWebSocketFactory = (url: string) => WebSocket;

export interface BridgeServerTransportOptions {
  readonly url: string;
  readonly sessionId?: string;
  readonly handshakeTimeoutMs?: number;
  readonly webSocketFactory?: BridgeWebSocketFactory;
}

interface QueuedMessage {
  readonly text: string;
  readonly bytes: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

function errorFromUnknown(
  value: unknown,
  code: BridgeServerTransportErrorCode,
  fallback: string,
): BridgeServerTransportError {
  const message = value instanceof Error ? value.message : fallback;
  return new BridgeServerTransportError(code, message || fallback);
}

function decodeFrame(data: unknown): string {
  if (typeof data === "string") return data;

  let bytes: Uint8Array | undefined;
  if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else if (ArrayBuffer.isView(data)) {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  if (!bytes) {
    throw new BridgeServerTransportError(
      "INVALID_MESSAGE",
      "Bridge message is not a supported WebSocket frame",
    );
  }

  if (bytes.byteLength > BRIDGE_MAX_MESSAGE_BYTES) {
    throw new BridgeServerTransportError(
      "MESSAGE_TOO_LARGE",
      "Bridge message exceeds the maximum size",
    );
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BridgeServerTransportError(
      "INVALID_MESSAGE",
      "Bridge message is not valid UTF-8",
    );
  }
}

function parseFrame(data: unknown): BridgeMessage {
  const text = decodeFrame(data);
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > BRIDGE_MAX_MESSAGE_BYTES) {
    throw new BridgeServerTransportError(
      "MESSAGE_TOO_LARGE",
      "Bridge message exceeds the maximum size",
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BridgeServerTransportError(
      "INVALID_MESSAGE",
      "Bridge message is not valid JSON",
    );
  }

  const parsed = bridgeMessageSchema.safeParse(value);
  if (!parsed.success) {
    throw new BridgeServerTransportError(
      "INVALID_MESSAGE",
      "Bridge message does not match the bridge contract",
    );
  }
  return parsed.data;
}

function serializeFrame(message: BridgeMessage): {
  text: string;
  bytes: number;
} {
  const parsed = bridgeMessageSchema.safeParse(message);
  if (!parsed.success) {
    throw new BridgeServerTransportError(
      "INVALID_MESSAGE",
      "Cannot send an invalid bridge message",
    );
  }

  const text = JSON.stringify(parsed.data);
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > BRIDGE_MAX_MESSAGE_BYTES) {
    throw new BridgeServerTransportError(
      "MESSAGE_TOO_LARGE",
      "Bridge message exceeds the maximum size",
    );
  }
  return { text, bytes };
}

function nativeCloseCode(code: BridgeCloseCode): number {
  switch (code) {
    case "NORMAL":
      return 1000;
    case "TIMEOUT":
      return 1001;
    case "PROTOCOL_ERROR":
      return WEBSOCKET_PROTOCOL_ERROR;
    case "SERVER_SHUTDOWN":
      return 1012;
  }
}

/** MCP server-side transport used by the local runtime. */
export class BridgeServerTransport implements BridgeServerTransportContract {
  readonly mcpRole = "server" as const;
  readonly maxMessageBytes = BRIDGE_MAX_MESSAGE_BYTES;
  readonly maxQueuedMessages = BRIDGE_MAX_QUEUED_MESSAGES;
  readonly maxQueuedBytes = BRIDGE_MAX_QUEUED_BYTES;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
  sessionId?: string;

  private readonly url: string;
  private readonly handshakeTimeoutMs: number;
  private readonly webSocketFactory: BridgeWebSocketFactory;
  private socket: WebSocket | null = null;
  private _state: BridgeServerTransportContract["state"] = "idle";
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private startPromise: Promise<void> | null = null;
  private resolveStart: (() => void) | null = null;
  private rejectStart: ((error: Error) => void) | null = null;
  private closePromise: Promise<void> = Promise.resolve();
  private resolveClose: (() => void) | null = null;
  private queue: QueuedMessage[] = [];
  private queuedBytes = 0;
  private currentSend: QueuedMessage | null = null;
  private nativeDrainBaseline = 0;
  private nativeDrainTimer: ReturnType<typeof setTimeout> | null = null;
  private drainScheduled = false;
  private draining = false;
  private callbackClosed = false;
  private errorReported = false;
  private intentionalClose = false;
  private remoteClose = false;
  private incomingChain: Promise<void> = Promise.resolve();

  constructor(
    urlOrOptions: string | BridgeServerTransportOptions,
    overrides: Omit<BridgeServerTransportOptions, "url"> = {},
  ) {
    const options: BridgeServerTransportOptions =
      typeof urlOrOptions === "string"
        ? { url: urlOrOptions, ...overrides }
        : urlOrOptions;
    if (!options.url) {
      throw new BridgeServerTransportError(
        "INVALID_STATE",
        "Bridge WebSocket URL is required",
      );
    }

    this.url = options.url;
    this.sessionId = options.sessionId ?? crypto.randomUUID();
    this.handshakeTimeoutMs =
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.webSocketFactory =
      options.webSocketFactory ?? ((url) => new WebSocket(url));
  }

  get state(): BridgeServerTransportContract["state"] {
    return this._state;
  }

  start(): Promise<void> {
    if (this._state !== "idle") {
      return Promise.reject(
        new BridgeServerTransportError(
          "INVALID_STATE",
          "Bridge transport can only be started once",
        ),
      );
    }

    this._state = "connecting";
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });

    try {
      const socket = this.webSocketFactory(this.url);
      this.socket = socket;
      socket.addEventListener("open", this.handleOpen);
      socket.addEventListener("message", this.handleMessage);
      socket.addEventListener("error", this.handleSocketError);
      socket.addEventListener("close", this.handleSocketClose);
    } catch (error) {
      this.fail(
        errorFromUnknown(
          error,
          "SOCKET_ERROR",
          "Failed to create the bridge WebSocket",
        ),
      );
    }

    return this.startPromise;
  }

  send(
    _message: JSONRPCMessage,
    _options?: TransportSendOptions,
  ): Promise<void> {
    if (this._state !== "ready") {
      return Promise.reject(
        new BridgeServerTransportError(
          this._state === "idle" ||
            this._state === "connecting" ||
            this._state === "handshaking"
            ? "HANDSHAKE_REQUIRED"
            : "SESSION_CLOSED",
          "Bridge transport is not ready",
        ),
      );
    }

    let frame: { text: string; bytes: number };
    try {
      frame = serializeFrame({ kind: "mcp.message", payload: _message });
    } catch (error) {
      return Promise.reject(error);
    }

    const currentBytes = this.currentSend?.bytes ?? 0;
    const queuedWithoutCurrent = this.queuedBytes - currentBytes;
    const nativeBufferedBytes = this.socket?.bufferedAmount ?? 0;
    const pendingNativeBytes = Math.max(nativeBufferedBytes, currentBytes);
    if (
      this.queue.length >= this.maxQueuedMessages ||
      queuedWithoutCurrent + pendingNativeBytes + frame.bytes >
        this.maxQueuedBytes
    ) {
      return Promise.reject(
        new BridgeServerTransportError(
          "BACKPRESSURE",
          "Bridge transport queue is full",
        ),
      );
    }

    return new Promise<void>((resolve, reject) => {
      this.queue.push({
        text: frame.text,
        bytes: frame.bytes,
        resolve,
        reject,
      });
      this.queuedBytes += frame.bytes;
      this.scheduleDrain();
    });
  }

  close(): Promise<void> {
    if (this._state === "closed") return this.closePromise;
    if (this._state === "closing") return this.closePromise;

    const wasReady = this._state === "ready";
    this.intentionalClose = true;
    this._state = "closing";
    this.clearHandshakeTimer();
    this.clearNativeDrainTimer();
    this.rejectQueued(
      new BridgeServerTransportError(
        "SESSION_CLOSED",
        "Bridge transport is closed",
      ),
    );

    this.closePromise = new Promise<void>((resolve) => {
      this.resolveClose = resolve;
    });

    const socket = this.socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      this.finalizeClose();
      return this.closePromise;
    }

    if (wasReady && socket.readyState === WebSocket.OPEN) {
      this.trySendControlFrame({ kind: "bridge.close", code: "NORMAL" });
    }
    try {
      socket.close(nativeCloseCode("NORMAL"), "NORMAL");
    } catch {
      this.finalizeClose();
    }
    return this.closePromise;
  }

  private readonly handleOpen = (): void => {
    if (this._state !== "connecting") return;
    this._state = "handshaking";
    this.setHandshakeTimer();
    try {
      const hello = serializeFrame({
        kind: "bridge.hello",
        bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
        role: "local-agent",
        sessionId: this.sessionId ?? crypto.randomUUID(),
      });
      this.socket?.send(hello.text);
    } catch (error) {
      this.fail(
        errorFromUnknown(
          error,
          "SOCKET_ERROR",
          "Failed to send bridge handshake",
        ),
      );
    }
  };

  private readonly handleMessage = (event: MessageEvent): void => {
    this.incomingChain = this.incomingChain
      .then(() => this.handleIncomingFrame(event.data))
      .catch((error: unknown) => {
        this.fail(
          errorFromUnknown(
            error,
            "INVALID_MESSAGE",
            "Failed to process bridge message",
          ),
        );
      });
  };

  private readonly handleSocketError = (): void => {
    this.fail(
      new BridgeServerTransportError(
        "SOCKET_ERROR",
        "Bridge WebSocket reported an error",
      ),
    );
  };

  private readonly handleSocketClose = (): void => {
    if (this._state === "closed") return;
    const unexpected = !this.intentionalClose && !this.remoteClose;
    if (unexpected && this._state !== "closing") {
      this.reportError(
        new BridgeServerTransportError(
          "SESSION_CLOSED",
          "Bridge WebSocket closed unexpectedly",
        ),
      );
    }
    this.finalizeClose();
  };

  private async handleIncomingFrame(data: unknown): Promise<void> {
    if (this._state === "closed" || this._state === "closing") return;

    let message: BridgeMessage;
    try {
      message = parseFrame(data);
    } catch (error) {
      const bridgeError = errorFromUnknown(
        error,
        "INVALID_MESSAGE",
        "Invalid bridge message",
      );
      this.fail(bridgeError, true);
      return;
    }

    if (this._state === "handshaking") {
      if (message.kind !== "bridge.hello.ack") {
        this.fail(
          new BridgeServerTransportError(
            "HANDSHAKE_REQUIRED",
            "Bridge handshake acknowledgement is required",
          ),
          true,
        );
        return;
      }
      if (message.bridgeProtocolVersion !== BRIDGE_PROTOCOL_VERSION) {
        this.fail(
          new BridgeServerTransportError(
            "UNSUPPORTED_VERSION",
            "Unsupported bridge protocol version",
          ),
          true,
        );
        return;
      }
      if (message.sessionId !== this.sessionId) {
        this.fail(
          new BridgeServerTransportError(
            "INVALID_MESSAGE",
            "Bridge handshake session does not match",
          ),
          true,
        );
        return;
      }

      this.clearHandshakeTimer();
      this._state = "ready";
      this.resolveStart?.();
      this.resolveStart = null;
      this.rejectStart = null;
      this.scheduleDrain();
      return;
    }

    if (this._state !== "ready") return;
    if (message.kind === "mcp.message") {
      try {
        this.onmessage?.(message.payload as JSONRPCMessage);
      } catch (error) {
        this.fail(
          errorFromUnknown(
            error,
            "SESSION_CLOSED",
            "MCP message callback failed",
          ),
        );
      }
      return;
    }
    if (message.kind === "bridge.close") {
      this.remoteClose = true;
      this._state = "closing";
      this.rejectQueued(
        new BridgeServerTransportError(
          "SESSION_CLOSED",
          "Bridge peer closed the session",
        ),
      );
      try {
        this.socket?.close(nativeCloseCode(message.code), message.code);
      } catch {
        this.finalizeClose();
      }
      return;
    }
    if (message.kind === "bridge.error") {
      this.fail(new BridgeServerTransportError(message.code, message.message));
      return;
    }

    this.fail(
      new BridgeServerTransportError(
        "UNEXPECTED_MESSAGE",
        "Unexpected bridge control message",
      ),
      true,
    );
  }

  private setHandshakeTimer(): void {
    this.clearHandshakeTimer();
    if (this.handshakeTimeoutMs <= 0) return;
    this.handshakeTimer = setTimeout(() => {
      this.fail(
        new BridgeServerTransportError("TIMEOUT", "Bridge handshake timed out"),
        true,
        "TIMEOUT",
      );
    }, this.handshakeTimeoutMs);
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer === null) return;
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
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
    if (this.draining || this.currentSend) return;
    this.draining = true;
    try {
      while (this._state === "ready") {
        const item = this.queue[0];
        if (!item) break;
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          this.fail(
            new BridgeServerTransportError(
              "SESSION_CLOSED",
              "Bridge WebSocket is not open",
            ),
          );
          break;
        }

        const bufferedBeforeSend = socket.bufferedAmount;
        if (bufferedBeforeSend + item.bytes > this.maxQueuedBytes) {
          this.scheduleNativeDrainPoll();
          break;
        }

        try {
          socket.send(item.text);
        } catch (error) {
          const sendError = errorFromUnknown(
            error,
            "SESSION_CLOSED",
            "Failed to send bridge message",
          );
          this.rejectQueued(sendError);
          this.fail(sendError);
          break;
        }

        const bufferedAfterSend = socket.bufferedAmount;
        if (bufferedAfterSend > bufferedBeforeSend) {
          this.currentSend = item;
          this.nativeDrainBaseline = bufferedBeforeSend;
          this.scheduleNativeDrainPoll();
          break;
        }

        this.queue.shift();
        this.queuedBytes -= item.bytes;
        item.resolve();
      }
    } finally {
      this.draining = false;
    }
  }

  private scheduleNativeDrainPoll(): void {
    if (this.nativeDrainTimer !== null) return;
    this.nativeDrainTimer = setTimeout(() => {
      this.nativeDrainTimer = null;
      if (
        this._state !== "ready" ||
        !this.currentSend ||
        !this.socket ||
        this.socket.readyState !== WebSocket.OPEN
      ) {
        return;
      }

      if (this.socket.bufferedAmount > this.nativeDrainBaseline) {
        this.scheduleNativeDrainPoll();
        return;
      }

      const item = this.currentSend;
      this.currentSend = null;
      this.nativeDrainBaseline = 0;
      if (this.queue[0] === item) {
        this.queue.shift();
        this.queuedBytes -= item.bytes;
      }
      item.resolve();
      this.scheduleDrain();
    }, NATIVE_DRAIN_POLL_MS);
  }

  private clearNativeDrainTimer(): void {
    if (this.nativeDrainTimer === null) return;
    clearTimeout(this.nativeDrainTimer);
    this.nativeDrainTimer = null;
  }

  private trySendControlFrame(message: BridgeMessage): void {
    try {
      const frame = serializeFrame(message);
      if (this.socket?.readyState === WebSocket.OPEN)
        this.socket.send(frame.text);
    } catch {
      // Native close remains authoritative when a socket is already failing.
    }
  }

  private fail(
    error: Error,
    announce = false,
    closeCode: BridgeCloseCode = "PROTOCOL_ERROR",
  ): void {
    if (this._state === "closed" || this._state === "closing") return;
    this._state = "failed";
    this.clearHandshakeTimer();
    this.clearNativeDrainTimer();
    this.rejectQueued(error);
    if (this.rejectStart) {
      this.rejectStart(error);
      this.resolveStart = null;
      this.rejectStart = null;
    }
    this.reportError(error);
    if (announce) {
      this.trySendControlFrame({
        kind: "bridge.error",
        code: this.bridgeErrorCode(error),
        message: error.message.slice(0, 500) || "Bridge transport failed",
      });
      this.trySendControlFrame({
        kind: "bridge.close",
        code: closeCode,
      });
    }
    try {
      this.socket?.close(
        nativeCloseCode(closeCode),
        error.message.slice(0, 123),
      );
    } catch {
      this.finalizeClose();
    }
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
      this.finalizeClose();
    }
  }

  private bridgeErrorCode(error: Error): BridgeErrorCode {
    if (error instanceof BridgeServerTransportError) {
      switch (error.code) {
        case "INVALID_MESSAGE":
        case "MESSAGE_TOO_LARGE":
        case "UNSUPPORTED_VERSION":
        case "HANDSHAKE_REQUIRED":
        case "UNEXPECTED_MESSAGE":
        case "SESSION_CLOSED":
        case "TIMEOUT":
        case "BACKPRESSURE":
          return error.code;
      }
    }
    return "SESSION_CLOSED";
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
    this.clearHandshakeTimer();
    this.clearNativeDrainTimer();
    this.detachSocketListeners();
    const closeError = new BridgeServerTransportError(
      "SESSION_CLOSED",
      "Bridge transport is closed",
    );
    this.rejectQueued(closeError);
    if (this.rejectStart) {
      this.rejectStart(closeError);
      this.resolveStart = null;
      this.rejectStart = null;
    }
    this._state = "closed";
    if (!this.callbackClosed) {
      this.callbackClosed = true;
      try {
        this.onclose?.();
      } catch {
        // Consumer callbacks must not break transport cleanup.
      }
    }
    this.resolveClose?.();
    this.resolveClose = null;
  }

  private detachSocketListeners(): void {
    const socket = this.socket;
    if (!socket) return;
    socket.removeEventListener("open", this.handleOpen);
    socket.removeEventListener("message", this.handleMessage);
    socket.removeEventListener("error", this.handleSocketError);
    socket.removeEventListener("close", this.handleSocketClose);
  }
}
