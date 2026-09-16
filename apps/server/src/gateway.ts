import {
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_QUEUED_BYTES,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeCloseCode,
  type BridgeErrorCode,
  type BridgeMessage,
  bridgeMessageSchema,
} from "@doctmcp/protocol";
import {
  type AuthenticatedDeviceIdentity,
  authenticatedDeviceIdentitySchema,
} from "@doctmcp/schemas";

const DEFAULT_BRIDGE_PATH = "/bridge";
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const WEBSOCKET_PROTOCOL_ERROR = 1002;

type GatewaySessionState = "handshaking" | "ready" | "closing" | "closed";

export type BridgeGatewayLogger = (
  event: string,
  details?: Readonly<Record<string, string>>,
) => void;

export type BridgeDeviceAuthenticator = (
  deviceId: string,
  credential: string,
) => Promise<AuthenticatedDeviceIdentity>;

/**
 * Synchronous lease acquired after authentication but before a session can become ready.
 * Throwing rejects the handshake before `bridge.hello.ack`. The returned release callback
 * is held through the ready transition/ACK so credential mutation can wait for this commit.
 */
export type BridgeSessionReadyGuard = (
  identity: AuthenticatedDeviceIdentity | null,
  sessionId: string,
) => (() => void) | undefined;

export type BridgeSessionReadyValidator = (
  deviceId: string,
  credential: string,
  identity: AuthenticatedDeviceIdentity,
  sessionId: string,
) => Promise<void>;

export type BridgeSessionHeartbeatHandler = (
  session: BridgeGatewaySession,
) => void | Promise<void>;

export type BridgeSessionClosedHandler = (
  session: BridgeGatewaySession,
  reason: BridgeCloseCode | "REMOTE_CLOSE",
) => void;

export interface BridgeGatewaySession {
  readonly id: string;
  readonly state: GatewaySessionState;
  readonly identity: AuthenticatedDeviceIdentity | null;
  onmessage: ((message: BridgeMessage) => void) | undefined;
  onclose: ((reason: BridgeCloseCode | "REMOTE_CLOSE") => void) | undefined;
  send(message: BridgeMessage): Promise<void>;
  close(code?: BridgeCloseCode, nativeReason?: string): Promise<void>;
}

export interface CreateBridgeGatewayOptions {
  host?: string;
  port?: number;
  path?: string;
  handshakeTimeoutMs?: number;
  idleTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  logger?: BridgeGatewayLogger;
  authenticateDevice?: BridgeDeviceAuthenticator;
  beginSessionReady?: BridgeSessionReadyGuard;
  validateSessionReady?: BridgeSessionReadyValidator;
  /** Chỉ dành cho M2 acceptance/test. Production mặc định yêu cầu device auth. */
  allowLegacyUnauthenticated?: boolean;
  onSession?: (session: BridgeGatewaySession) => void;
  onHeartbeat?: BridgeSessionHeartbeatHandler;
  onSessionClosed?: BridgeSessionClosedHandler;
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
  readonly onSessionClosed: BridgeSessionClosedHandler | undefined;
  ws: Bun.ServerWebSocket<BridgeSocketData> | null;
  session: GatewaySession | null;
  state: GatewaySessionState;
  closeReason: BridgeCloseCode | "REMOTE_CLOSE" | null;
  timeout: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
  heartbeatNonce: string | null;
  heartbeatValidating: boolean;
  lastHeartbeatAtMs: number;
  finalized: boolean;
}

interface SerializedFrame {
  readonly text: string;
}

class GatewaySession implements BridgeGatewaySession {
  onmessage: ((message: BridgeMessage) => void) | undefined;
  onclose: ((reason: BridgeCloseCode | "REMOTE_CLOSE") => void) | undefined;

  constructor(
    private readonly connection: GatewayConnection,
    private readonly sendFrame: (
      connection: GatewayConnection,
      message: BridgeMessage,
    ) => Promise<void>,
    readonly id: string,
    readonly identity: AuthenticatedDeviceIdentity | null,
  ) {}

  get state(): GatewaySessionState {
    return this.connection.state;
  }

  send(message: BridgeMessage): Promise<void> {
    if (this.connection.state !== "ready") {
      return Promise.reject(
        new BridgeGatewayError(
          this.connection.state === "handshaking"
            ? "HANDSHAKE_REQUIRED"
            : "SESSION_CLOSED",
          "Bridge session is not ready",
        ),
      );
    }
    return this.sendFrame(this.connection, message);
  }

  close(
    code: BridgeCloseCode = "NORMAL",
    nativeReason: string = code,
  ): Promise<void> {
    return closeConnection(this.connection, code, true, nativeReason);
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
  if (new TextEncoder().encode(text).byteLength > BRIDGE_MAX_MESSAGE_BYTES) {
    throw new BridgeGatewayError(
      "MESSAGE_TOO_LARGE",
      "Bridge message exceeds the maximum size",
    );
  }
  return { text };
}

function parseIncomingFrame(frame: string | Buffer): BridgeMessage {
  if (
    typeof frame !== "string" &&
    frame.byteLength > BRIDGE_MAX_MESSAGE_BYTES
  ) {
    throw new BridgeGatewayError(
      "MESSAGE_TOO_LARGE",
      "Bridge message exceeds the maximum size",
    );
  }

  let text: string;
  if (typeof frame === "string") {
    if (new TextEncoder().encode(frame).byteLength > BRIDGE_MAX_MESSAGE_BYTES) {
      throw new BridgeGatewayError(
        "MESSAGE_TOO_LARGE",
        "Bridge message exceeds the maximum size",
      );
    }
    text = frame;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
    } catch {
      throw new BridgeGatewayError("SESSION_CLOSED", "Invalid bridge frame");
    }
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BridgeGatewayError("SESSION_CLOSED", "Invalid bridge JSON");
  }

  const parsed = bridgeMessageSchema.safeParse(value);
  if (!parsed.success)
    throw new BridgeGatewayError("SESSION_CLOSED", "Invalid bridge message");
  return parsed.data;
}

function decodeHeartbeatPayload(payload: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    return null;
  }
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

function clearConnectionTimeout(connection: GatewayConnection): void {
  if (connection.timeout !== null) {
    clearTimeout(connection.timeout);
    connection.timeout = null;
  }
}

function clearHeartbeatTimer(connection: GatewayConnection): void {
  if (connection.heartbeatTimer !== null) {
    clearTimeout(connection.heartbeatTimer);
    connection.heartbeatTimer = null;
  }
}

function finalizeConnection(
  connection: GatewayConnection,
  reason: BridgeCloseCode | "REMOTE_CLOSE",
): void {
  if (connection.finalized) return;
  connection.finalized = true;
  clearConnectionTimeout(connection);
  clearHeartbeatTimer(connection);
  connection.heartbeatNonce = null;
  connection.heartbeatValidating = false;
  connection.state = "closed";
  const session = connection.session;
  try {
    session?.onclose?.(reason);
  } catch {
    // Consumer callback không được phá cleanup.
  }
  if (session) {
    try {
      connection.onSessionClosed?.(session, reason);
    } catch {
      // Runtime cleanup callback không được phá connection cleanup.
    }
  }
}

function closeConnection(
  connection: GatewayConnection,
  code: BridgeCloseCode,
  announce = true,
  nativeReason: string = code,
): Promise<void> {
  if (
    connection.finalized ||
    connection.state === "closing" ||
    connection.state === "closed"
  ) {
    return Promise.resolve();
  }

  clearConnectionTimeout(connection);
  clearHeartbeatTimer(connection);
  connection.heartbeatNonce = null;
  connection.heartbeatValidating = false;
  connection.closeReason = code;
  connection.state = "closing";
  const ws = connection.ws;
  if (!ws) {
    finalizeConnection(connection, code);
    return Promise.resolve();
  }

  if (announce) {
    try {
      ws.send(serializeFrame({ kind: "bridge.close", code }).text);
    } catch {
      // Native close remains authoritative.
    }
  }
  ws.close(nativeCloseCode(code), nativeReason.slice(0, 123));
  return Promise.resolve();
}

export function sendWebSocketFrameOnce(send: () => number): void {
  const status = send();
  if (status === 0 || status < -1) {
    throw new BridgeGatewayError("SESSION_CLOSED", "Bridge socket send failed");
  }
}

export async function sendWebSocketFrameOrCleanup(
  send: () => number,
  cleanup: () => Promise<void>,
): Promise<void> {
  try {
    sendWebSocketFrameOnce(send);
  } catch {
    await cleanup();
    throw new BridgeGatewayError("SESSION_CLOSED", "Bridge socket is closed");
  }
}

export function createBridgeGateway(
  options: CreateBridgeGatewayOptions = {},
): BridgeGateway {
  const path = options.path ?? DEFAULT_BRIDGE_PATH;
  const handshakeTimeoutMs =
    options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 0;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 0;
  if (
    !Number.isFinite(heartbeatIntervalMs) ||
    heartbeatIntervalMs < 0 ||
    !Number.isFinite(heartbeatTimeoutMs) ||
    heartbeatTimeoutMs < 0 ||
    ((heartbeatIntervalMs === 0) !== (heartbeatTimeoutMs === 0)) ||
    (heartbeatIntervalMs > 0 && heartbeatTimeoutMs <= heartbeatIntervalMs)
  ) {
    throw new Error(
      "Bridge heartbeat requires interval > 0 and timeout > interval, or both disabled.",
    );
  }

  const connections = new Map<string, GatewayConnection>();
  const sessions = new Map<string, GatewaySession>();
  let stopped = false;

  const log = (event: string, connection: GatewayConnection): void => {
    const details: Record<string, string> = {};
    if (connection.session) {
      details.sessionId = connection.session.id;
      if (connection.session.identity)
        details.deviceId = connection.session.identity.deviceId;
    }
    options.logger?.(event, details);
  };

  const setTimeoutFor = (
    connection: GatewayConnection,
    timeoutMs: number,
    handler: () => void,
  ): void => {
    clearConnectionTimeout(connection);
    if (timeoutMs > 0) connection.timeout = setTimeout(handler, timeoutMs);
  };

  const usesAuthenticatedHeartbeat = (connection: GatewayConnection): boolean =>
    heartbeatIntervalMs > 0 &&
    heartbeatTimeoutMs > 0 &&
    connection.session?.identity !== null;

  const armReadyIdleTimeout = (connection: GatewayConnection): void => {
    if (usesAuthenticatedHeartbeat(connection)) {
      clearConnectionTimeout(connection);
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
  };

  const failConnection = async (
    connection: GatewayConnection,
    errorCode: BridgeErrorCode,
    closeCode: BridgeCloseCode,
    message: string,
  ): Promise<void> => {
    if (connection.finalized || connection.state === "closing") return;
    clearConnectionTimeout(connection);
    clearHeartbeatTimer(connection);
    connection.heartbeatNonce = null;
    connection.heartbeatValidating = false;
    connection.closeReason = closeCode;
    connection.state = "closing";

    if (connection.ws) {
      try {
        sendWebSocketFrameOnce(
          () =>
            connection.ws?.send(
              serializeFrame({
                kind: "bridge.error",
                code: errorCode,
                message,
              }).text,
            ) ?? 0,
        );
        sendWebSocketFrameOnce(
          () =>
            connection.ws?.send(
              serializeFrame({ kind: "bridge.close", code: closeCode }).text,
            ) ?? 0,
        );
      } catch {
        // Best-effort protocol error; native close remains authoritative.
      }
      connection.ws.close(nativeCloseCode(closeCode), message.slice(0, 123));
    }
    log("bridge.connection.failed", connection);
  };

  const scheduleHeartbeat = (connection: GatewayConnection): void => {
    clearHeartbeatTimer(connection);
    if (!usesAuthenticatedHeartbeat(connection)) return;
    connection.heartbeatTimer = setTimeout(() => {
      connection.heartbeatTimer = null;
      if (
        connection.finalized ||
        connection.state !== "ready" ||
        !connection.ws ||
        !connection.session
      ) {
        return;
      }

      if (Date.now() - connection.lastHeartbeatAtMs >= heartbeatTimeoutMs) {
        void failConnection(
          connection,
          "TIMEOUT",
          "TIMEOUT",
          "Device heartbeat timed out",
        );
        return;
      }

      if (!connection.heartbeatNonce && !connection.heartbeatValidating) {
        const nonce = globalThis.crypto.randomUUID();
        connection.heartbeatNonce = nonce;
        try {
          sendWebSocketFrameOnce(() => connection.ws?.ping(nonce) ?? 0);
        } catch {
          void failConnection(
            connection,
            "SESSION_CLOSED",
            "NORMAL",
            "Device heartbeat send failed",
          );
          return;
        }
      }
      scheduleHeartbeat(connection);
    }, heartbeatIntervalMs);
  };

  const sendFrame = async (
    connection: GatewayConnection,
    message: BridgeMessage,
  ): Promise<void> => {
    if (
      connection.finalized ||
      connection.state !== "ready" ||
      !connection.ws
    ) {
      throw new BridgeGatewayError(
        "SESSION_CLOSED",
        "Bridge session is closed",
      );
    }

    // Validation/serialization errors are caller errors, not socket failures.
    // Only a native ws.send failure is allowed to tear down the ready session.
    const frame = serializeFrame(message);
    await sendWebSocketFrameOrCleanup(
      () => connection.ws?.send(frame.text) ?? 0,
      async () => {
        if (connection.session) sessions.delete(connection.session.id);
        await closeConnection(connection, "NORMAL");
      },
    );
    armReadyIdleTimeout(connection);
  };

  const authenticate = async (
    message: Extract<BridgeMessage, { kind: "bridge.hello" }>,
  ): Promise<AuthenticatedDeviceIdentity | null> => {
    if (!message.auth) {
      if (options.allowLegacyUnauthenticated === true) return null;
      throw new Error("AUTH_REQUIRED");
    }
    if (!options.authenticateDevice) throw new Error("AUTH_FAILED");

    const result = await options.authenticateDevice(
      message.auth.deviceId,
      message.auth.credential,
    );
    const identity = authenticatedDeviceIdentitySchema.safeParse(result);
    if (!identity.success || identity.data.deviceId !== message.auth.deviceId) {
      throw new Error("AUTH_FAILED");
    }
    return Object.freeze(identity.data);
  };

  const handleMessage = async (
    connection: GatewayConnection,
    raw: string | Buffer,
  ): Promise<void> => {
    if (connection.finalized || connection.state === "closing") return;

    let message: BridgeMessage;
    try {
      message = parseIncomingFrame(raw);
    } catch (error) {
      await failConnection(
        connection,
        error instanceof BridgeGatewayError &&
          error.code === "MESSAGE_TOO_LARGE"
          ? "MESSAGE_TOO_LARGE"
          : "INVALID_MESSAGE",
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
        await failConnection(
          connection,
          "UNSUPPORTED_VERSION",
          "PROTOCOL_ERROR",
          "Unsupported bridge protocol version",
        );
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

      let identity: AuthenticatedDeviceIdentity | null;
      try {
        identity = await authenticate(message);
      } catch (error) {
        const code =
          error instanceof Error && error.message === "AUTH_REQUIRED"
            ? "AUTH_REQUIRED"
            : "AUTH_FAILED";
        await failConnection(
          connection,
          code,
          "PROTOCOL_ERROR",
          code === "AUTH_REQUIRED"
            ? "Device authentication is required"
            : "Device authentication failed",
        );
        return;
      }
      if (connection.finalized || connection.state !== "handshaking") return;
      if (sessions.has(message.sessionId)) {
        await failConnection(
          connection,
          "UNEXPECTED_MESSAGE",
          "PROTOCOL_ERROR",
          "Bridge session is already active",
        );
        return;
      }

      let releaseReadyGuard: (() => void) | undefined;
      try {
        releaseReadyGuard =
          options.beginSessionReady?.(identity, message.sessionId) ?? undefined;
      } catch {
        await failConnection(
          connection,
          "AUTH_FAILED",
          "PROTOCOL_ERROR",
          "Device authentication failed",
        );
        return;
      }

      try {
        if (identity && message.auth && options.validateSessionReady) {
          try {
            await options.validateSessionReady(
              message.auth.deviceId,
              message.auth.credential,
              identity,
              message.sessionId,
            );
          } catch {
            await failConnection(
              connection,
              "AUTH_FAILED",
              "PROTOCOL_ERROR",
              "Device authentication failed",
            );
            return;
          }
        }

        if (connection.finalized || connection.state !== "handshaking") return;
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
          identity,
        );
        connection.session = session;
        sessions.set(session.id, session);
        clearConnectionTimeout(connection);
        connection.state = "ready";
        connection.lastHeartbeatAtMs = Date.now();
        armReadyIdleTimeout(connection);

        try {
          sendWebSocketFrameOnce(
            () =>
              connection.ws?.send(
                serializeFrame({
                  kind: "bridge.hello.ack",
                  bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
                  role: "public-server",
                  sessionId: session.id,
                }).text,
              ) ?? 0,
          );
          options.onSession?.(session);
        } catch {
          sessions.delete(session.id);
          await failConnection(
            connection,
            "SESSION_CLOSED",
            "PROTOCOL_ERROR",
            "Bridge session binding failed",
          );
          return;
        }
        scheduleHeartbeat(connection);
        log("bridge.session.ready", connection);
        return;
      } finally {
        releaseReadyGuard?.();
      }
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

    armReadyIdleTimeout(connection);
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

  const handlePong = (
    connection: GatewayConnection,
    payload: Buffer,
  ): void => {
    if (
      connection.finalized ||
      connection.state !== "ready" ||
      !connection.session ||
      !connection.session.identity ||
      connection.heartbeatValidating
    ) {
      return;
    }
    const nonce = decodeHeartbeatPayload(payload);
    if (!nonce || nonce !== connection.heartbeatNonce) return;

    connection.heartbeatNonce = null;
    connection.heartbeatValidating = true;
    Promise.resolve(options.onHeartbeat?.(connection.session))
      .then(() => {
        if (
          connection.finalized ||
          connection.state !== "ready" ||
          !connection.session
        ) {
          return;
        }
        connection.lastHeartbeatAtMs = Date.now();
        connection.heartbeatValidating = false;
      })
      .catch(() => {
        connection.heartbeatValidating = false;
        void failConnection(
          connection,
          "AUTH_FAILED",
          "PROTOCOL_ERROR",
          "Device session liveness validation failed",
        );
      });
  };

  const server = Bun.serve<BridgeSocketData>({
    hostname: options.host,
    port: options.port ?? 0,
    websocket: {
      data: {} as BridgeSocketData,
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
      pong(ws, data) {
        const connection = connections.get(ws.data.connectionId);
        if (connection) handlePong(connection, data);
      },
      close(ws) {
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
      const connection: GatewayConnection = {
        connectionId,
        onSessionClosed: options.onSessionClosed,
        ws: null,
        session: null,
        state: "handshaking",
        closeReason: null,
        timeout: null,
        heartbeatTimer: null,
        heartbeatNonce: null,
        heartbeatValidating: false,
        lastHeartbeatAtMs: 0,
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
