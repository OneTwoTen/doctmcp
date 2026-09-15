import {
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_QUEUED_BYTES,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeCloseCode,
  type BridgeErrorCode,
  type BridgeMessage,
  bridgeMessageSchema,
} from "@doctmcp/protocol";

const DEFAULT_BRIDGE_PATH = "/bridge";
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const WEBSOCKET_PROTOCOL_ERROR = 1002;

type GatewaySessionState = "handshaking" | "ready" | "closing" | "closed";

export type BridgeGatewayLogger = (
  event: string,
  details?: Readonly<Record<string, string>>,
) => void;

export interface BridgeGatewaySession {
  readonly id: string;
  readonly state: GatewaySessionState;
  onmessage: ((message: BridgeMessage) => void) | undefined;
  onclose: ((reason: BridgeCloseCode | "REMOTE_CLOSE") => void) | undefined;
  send(message: BridgeMessage): Promise<void>;
  close(code?: BridgeCloseCode): Promise<void>;
}

export interface CreateBridgeGatewayOptions {
  host?: string;
  port?: number;
  path?: string;
  handshakeTimeoutMs?: number;
  idleTimeoutMs?: number;
  logger?: BridgeGatewayLogger;
  onSession?: (session: BridgeGatewaySession) => void;
}

export interface BridgeGateway {
  readonly url: string;
  readonly path: string;
  readonly sessionCount: number;
  readonly server: Bun.Server<BridgeSocketData>;
  getSession(sessionId: string): BridgeGatewaySession | undefined;
  stop(): Promise<void>;
}

export class BridgeGatewayError extends Error {
  readonly code:
    | "BACKPRESSURE"
    | "HANDSHAKE_REQUIRED"
    | "MESSAGE_TOO_LARGE"
    | "SESSION_CLOSED";

  constructor(code: BridgeGatewayError["code"], message: string) {
    super(message);
    this.name = "BridgeGatewayError";
    this.code = code;
  }
}

interface BridgeSocketData {
  readonly connectionId: string;
}

interface GatewayConnection {
  readonly connectionId: string;
  readonly ws: Bun.ServerWebSocket<BridgeSocketData> | null;
  session: GatewaySession | null;
  state: GatewaySessionState;
  closeReason: BridgeCloseCode | "REMOTE_CLOSE" | null;
  timeout: ReturnType<typeof setTimeout> | null;
  finalized: boolean;
}

interface MutableGatewayConnection extends Omit<GatewayConnection, "ws"> {
  ws: Bun.ServerWebSocket<BridgeSocketData> | null;
}

interface SerializedFrame {
  readonly text: string;
}

class GatewaySession implements BridgeGatewaySession {
  readonly id: string;
  onmessage: ((message: BridgeMessage) => void) | undefined;
  onclose: ((reason: BridgeCloseCode | "REMOTE_CLOSE") => void) | undefined;

  constructor(
    private readonly connection: MutableGatewayConnection,
    private readonly sendFrame: (
      connection: MutableGatewayConnection,
      message: BridgeMessage,
    ) => Promise<void>,
    id: string,
  ) {
    this.id = id;
  }

  get state(): GatewaySessionState {
    return this.connection.state;
  }

  send(message: BridgeMessage): Promise<void> {
    if (this.connection.state !== "ready") {
      if (this.connection.state === "handshaking") {
        return Promise.reject(
          new BridgeGatewayError(
            "HANDSHAKE_REQUIRED",
            "Bridge handshake is not complete",
          ),
        );
      }
      return Promise.reject(
        new BridgeGatewayError("SESSION_CLOSED", "Bridge session is closed"),
      );
    }
    return this.sendFrame(this.connection, message);
  }

  close(code: BridgeCloseCode = "NORMAL"): Promise<void> {
    return closeConnection(this.connection, code);
  }
}

function serializeFrame(message: BridgeMessage): SerializedFrame {
  const parsed = bridgeMessageSchema.safeParse(message);
  if (!parsed.success) {
    throw new BridgeGatewayError(
      "SESSION_CLOSED",
      "Gateway cannot send an invalid bridge message",
    );
  }

  const text = JSON.stringify(parsed.data);
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > BRIDGE_MAX_MESSAGE_BYTES) {
    throw new BridgeGatewayError(
      "MESSAGE_TOO_LARGE",
      "Bridge message exceeds the maximum size",
    );
  }
  return { text };
}

function decodeFrame(frame: string | Buffer): string {
  if (typeof frame === "string") {
    const bytes = new TextEncoder().encode(frame).byteLength;
    if (bytes > BRIDGE_MAX_MESSAGE_BYTES) {
      throw new BridgeGatewayError(
        "MESSAGE_TOO_LARGE",
        "Bridge message exceeds the maximum size",
      );
    }
    return frame;
  }

  if (frame.byteLength > BRIDGE_MAX_MESSAGE_BYTES) {
    throw new BridgeGatewayError(
      "MESSAGE_TOO_LARGE",
      "Bridge message exceeds the maximum size",
    );
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(frame);
  } catch {
    throw new BridgeGatewayError(
      "SESSION_CLOSED",
      "Bridge message is not valid UTF-8",
    );
  }
}

function parseIncomingFrame(frame: string | Buffer): BridgeMessage {
  let text: string;
  try {
    text = decodeFrame(frame);
  } catch (error) {
    if (error instanceof BridgeGatewayError) throw error;
    throw new BridgeGatewayError("SESSION_CLOSED", "Invalid bridge frame");
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BridgeGatewayError("SESSION_CLOSED", "Invalid bridge JSON");
  }

  const parsed = bridgeMessageSchema.safeParse(value);
  if (!parsed.success) {
    throw new BridgeGatewayError("SESSION_CLOSED", "Invalid bridge message");
  }
  return parsed.data;
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

function clearConnectionTimeout(connection: MutableGatewayConnection): void {
  if (connection.timeout !== null) {
    clearTimeout(connection.timeout);
    connection.timeout = null;
  }
}

function closeConnection(
  connection: MutableGatewayConnection,
  code: BridgeCloseCode,
  announce = true,
): Promise<void> {
  if (
    connection.finalized ||
    connection.state === "closing" ||
    connection.state === "closed"
  ) {
    return Promise.resolve();
  }

  clearConnectionTimeout(connection);
  connection.closeReason = code;
  connection.state = "closing";

  const ws = connection.ws;
  if (!ws) {
    finalizeConnection(connection, code);
    return Promise.resolve();
  }

  if (announce) {
    try {
      const frame = serializeFrame({ kind: "bridge.close", code });
      ws.send(frame.text);
    } catch {
      // Socket có thể đã đóng giữa lúc chuẩn bị close; callback close sẽ cleanup.
    }
  }
  ws.close(nativeCloseCode(code), code);
  return Promise.resolve();
}

function finalizeConnection(
  connection: MutableGatewayConnection,
  reason: BridgeCloseCode | "REMOTE_CLOSE",
): void {
  if (connection.finalized) return;
  connection.finalized = true;
  clearConnectionTimeout(connection);
  connection.state = "closed";

  const session = connection.session;
  if (session?.onclose) {
    try {
      session.onclose(reason);
    } catch {
      // Callback của consumer không được làm lỗi cleanup lan ra runtime.
    }
  }
}

/**
 * Bun trả -1 khi frame đã được enqueue nhưng socket đang chịu backpressure.
 * Đây là success của lần gửi hiện tại, không phải tín hiệu để retry.
 */
export function sendWebSocketFrameOnce(send: () => number): void {
  const status = send();
  if (status === 0) {
    throw new BridgeGatewayError(
      "SESSION_CLOSED",
      "Bridge message was dropped",
    );
  }
  if (status < -1) {
    throw new BridgeGatewayError("SESSION_CLOSED", "Bridge socket send failed");
  }
}

export function createBridgeGateway(
  options: CreateBridgeGatewayOptions = {},
): BridgeGateway {
  const path = options.path ?? DEFAULT_BRIDGE_PATH;
  const handshakeTimeoutMs =
    options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const logger = options.logger;
  const connections = new Map<string, MutableGatewayConnection>();
  const sessions = new Map<string, GatewaySession>();
  let stopped = false;

  const log = (event: string, connection: MutableGatewayConnection): void => {
    logger?.(
      event,
      connection.session ? { sessionId: connection.session.id } : {},
    );
  };

  const setTimeoutFor = (
    connection: MutableGatewayConnection,
    timeoutMs: number,
    handler: () => void,
  ): void => {
    clearConnectionTimeout(connection);
    if (timeoutMs <= 0) return;
    connection.timeout = setTimeout(handler, timeoutMs);
  };

  const sendFrame = async (
    connection: MutableGatewayConnection,
    message: BridgeMessage,
  ): Promise<void> => {
    if (
      connection.finalized ||
      connection.state === "closed" ||
      !connection.ws
    ) {
      throw new BridgeGatewayError(
        "SESSION_CLOSED",
        "Bridge session is closed",
      );
    }

    const frame = serializeFrame(message);
    try {
      sendWebSocketFrameOnce(() => connection.ws?.send(frame.text) ?? 0);
    } catch {
      await closeConnection(connection, "NORMAL");
      throw new BridgeGatewayError("SESSION_CLOSED", "Bridge socket is closed");
    }
    if (connection.state === "ready") {
      setTimeoutFor(connection, idleTimeoutMs, () => {
        void failConnection(
          connection,
          "TIMEOUT",
          "TIMEOUT",
          "Bridge session timed out",
        );
      });
    }
  };

  const failConnection = async (
    connection: MutableGatewayConnection,
    errorCode: BridgeErrorCode,
    closeCode: BridgeCloseCode,
    message: string,
  ): Promise<void> => {
    if (connection.finalized || connection.state === "closing") return;
    clearConnectionTimeout(connection);
    connection.closeReason = closeCode;
    connection.state = "closing";

    if (connection.ws) {
      try {
        const errorMessage: BridgeMessage = {
          kind: "bridge.error",
          code: errorCode,
          message,
        };
        const errorFrame = serializeFrame(errorMessage);
        sendWebSocketFrameOnce(() => connection.ws?.send(errorFrame.text) ?? 0);
        const closeFrame = serializeFrame({
          kind: "bridge.close",
          code: closeCode,
        });
        sendWebSocketFrameOnce(() => connection.ws?.send(closeFrame.text) ?? 0);
      } catch {
        // Best effort protocol error; native close remains authoritative.
      }
      connection.ws.close(nativeCloseCode(closeCode), message);
    }
    log("bridge.connection.failed", connection);
  };

  const handleMessage = async (
    connection: MutableGatewayConnection,
    raw: string | Buffer,
  ): Promise<void> => {
    if (connection.finalized || connection.state === "closing") return;

    let message: BridgeMessage;
    try {
      message = parseIncomingFrame(raw);
    } catch (error) {
      if (
        error instanceof BridgeGatewayError &&
        error.code === "MESSAGE_TOO_LARGE"
      ) {
        await failConnection(
          connection,
          "MESSAGE_TOO_LARGE",
          "PROTOCOL_ERROR",
          "Bridge message exceeds the maximum size",
        );
        return;
      }
      await failConnection(
        connection,
        "INVALID_MESSAGE",
        "PROTOCOL_ERROR",
        "Invalid bridge message",
      );
      return;
    }

    if (connection.state === "handshaking") {
      if (message.kind !== "bridge.hello") {
        await failConnection(
          connection,
          "HANDSHAKE_REQUIRED",
          "PROTOCOL_ERROR",
          "Handshake is required before this message",
        );
        return;
      }
      if (message.bridgeProtocolVersion !== BRIDGE_PROTOCOL_VERSION) {
        clearConnectionTimeout(connection);
        connection.closeReason = "PROTOCOL_ERROR";
        connection.state = "closing";
        try {
          const errorFrame = serializeFrame({
            kind: "bridge.error",
            code: "UNSUPPORTED_VERSION",
            message: "Unsupported bridge protocol version",
          });
          sendWebSocketFrameOnce(
            () => connection.ws?.send(errorFrame.text) ?? 0,
          );
          const closeFrame = serializeFrame({
            kind: "bridge.close",
            code: "PROTOCOL_ERROR",
          });
          sendWebSocketFrameOnce(
            () => connection.ws?.send(closeFrame.text) ?? 0,
          );
        } catch {
          // Best effort protocol response.
        }
        connection.ws?.close(WEBSOCKET_PROTOCOL_ERROR, "UNSUPPORTED_VERSION");
        log("bridge.connection.unsupported_version", connection);
        return;
      }
      if (sessions.has(message.sessionId)) {
        await failConnection(
          connection,
          "UNEXPECTED_MESSAGE",
          "PROTOCOL_ERROR",
          "Bridge session is already active",
        );
        return;
      }

      const session = new GatewaySession(
        connection,
        sendFrame,
        message.sessionId,
      );
      connection.session = session;
      sessions.set(session.id, session);
      clearConnectionTimeout(connection);
      connection.state = "ready";
      setTimeoutFor(connection, idleTimeoutMs, () => {
        void failConnection(
          connection,
          "TIMEOUT",
          "TIMEOUT",
          "Bridge session timed out",
        );
      });

      try {
        const ack = serializeFrame({
          kind: "bridge.hello.ack",
          bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
          role: "public-server",
          sessionId: session.id,
        });
        connection.ws?.send(ack.text);
      } catch {
        await closeConnection(connection, "NORMAL");
        return;
      }

      try {
        options.onSession?.(session);
      } catch {
        await failConnection(
          connection,
          "SESSION_CLOSED",
          "PROTOCOL_ERROR",
          "Bridge session binding failed",
        );
        return;
      }
      log("bridge.session.ready", connection);
      return;
    }

    if (message.kind === "bridge.close") {
      await closeConnection(connection, message.code, false);
      return;
    }

    if (message.kind !== "mcp.message") {
      await failConnection(
        connection,
        "UNEXPECTED_MESSAGE",
        "PROTOCOL_ERROR",
        "Unexpected bridge message",
      );
      return;
    }

    setTimeoutFor(connection, idleTimeoutMs, () => {
      void failConnection(
        connection,
        "TIMEOUT",
        "TIMEOUT",
        "Bridge session timed out",
      );
    });
    try {
      connection.session?.onmessage?.(message);
    } catch {
      await failConnection(
        connection,
        "SESSION_CLOSED",
        "PROTOCOL_ERROR",
        "Bridge session forwarding failed",
      );
    }
  };

  const server = Bun.serve<BridgeSocketData>({
    hostname: options.host,
    port: options.port ?? 0,
    websocket: {
      data: {} as BridgeSocketData,
      // Chừa một khoảng nhỏ để tự gửi bridge.error trước khi đóng; giới hạn
      // chính xác của bridge vẫn do decodeFrame() enforce trên wire UTF-8.
      maxPayloadLength: BRIDGE_MAX_MESSAGE_BYTES + 4_096,
      backpressureLimit: BRIDGE_MAX_QUEUED_BYTES,
      closeOnBackpressureLimit: false,
      open(ws) {
        const connection = connections.get(ws.data.connectionId);
        if (!connection) {
          ws.close(WEBSOCKET_PROTOCOL_ERROR, "Unknown bridge connection");
          return;
        }
        connection.ws = ws;
        setTimeoutFor(connection, handshakeTimeoutMs, () => {
          void failConnection(
            connection,
            "TIMEOUT",
            "TIMEOUT",
            "Bridge handshake timed out",
          );
        });
        log("bridge.connection.opened", connection);
      },
      message(ws, message) {
        const connection = connections.get(ws.data.connectionId);
        if (connection) void handleMessage(connection, message);
      },
      close(ws, _code, _reason) {
        const connection = connections.get(ws.data.connectionId);
        if (!connection) return;
        if (connection.session) sessions.delete(connection.session.id);
        connections.delete(connection.connectionId);
        finalizeConnection(
          connection,
          connection.closeReason ?? "REMOTE_CLOSE",
        );
        log("bridge.connection.closed", connection);
      },
    },
    fetch(request, serverInstance) {
      const requestUrl = new URL(request.url);
      if (requestUrl.pathname !== path) {
        return new Response("Not found", { status: 404 });
      }
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }

      const connectionId = crypto.randomUUID();
      const connection: MutableGatewayConnection = {
        connectionId,
        ws: null,
        session: null,
        state: "handshaking",
        closeReason: null,
        timeout: null,
        finalized: false,
      };
      connections.set(connectionId, connection);
      if (serverInstance.upgrade(request, { data: { connectionId } })) return;
      connections.delete(connectionId);
      return new Response("WebSocket upgrade required", { status: 400 });
    },
  });

  return {
    get url() {
      return `ws://${server.hostname}:${server.port}${path}`;
    },
    path,
    get sessionCount() {
      return sessions.size;
    },
    server,
    getSession(sessionId) {
      return sessions.get(sessionId);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      const activeConnections = [...connections.values()];
      await Promise.all(
        activeConnections.map((connection) =>
          closeConnection(connection, "SERVER_SHUTDOWN"),
        ),
      );
      for (const connection of activeConnections) {
        if (connection.session) sessions.delete(connection.session.id);
        connections.delete(connection.connectionId);
        finalizeConnection(
          connection,
          connection.closeReason ?? "SERVER_SHUTDOWN",
        );
      }
      await server.stop(true);
    },
  };
}

export { DEFAULT_BRIDGE_PATH };
