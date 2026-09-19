import { pairingChannelMessageSchema } from "@doctmcp/protocol";
import { pairingSessionIdSchema } from "@doctmcp/schemas";
import type {
  DeviceCredentialProvider,
  LocalDeviceCredential,
} from "./device-credential-provider";

export interface LocalPairingClientOptions {
  readonly serverUrl: string;
  readonly deviceName: string;
  readonly credentialProvider: DeviceCredentialProvider;
  readonly fetch?: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  readonly createWebSocket?: (url: string) => PairingWebSocket;
  readonly randomBytes?: (length: number) => Uint8Array;
  readonly onPairingCode?: (pairingCode: string, expiresAt: Date) => void;
}

export interface PairingWebSocket {
  readonly readyState: number;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: Event | MessageEvent) => void,
  ): void;
  removeEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: Event | MessageEvent) => void,
  ): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type LocalPairingClientErrorCode =
  | "PAIRING_UNAVAILABLE"
  | "PAIRING_STORAGE_FAILED"
  | "PAIRING_PROTOCOL_FAILED"
  | "PAIRING_CLOSED";

export class LocalPairingClientError extends Error {
  constructor(public readonly code: LocalPairingClientErrorCode) {
    super("Không thể hoàn tất pairing local.");
    this.name = "LocalPairingClientError";
  }
}

interface PairingStartResponse {
  readonly pairingSessionId: string;
  readonly pairingCode: string;
  readonly expiresAt: Date;
}

const MAX_PAIRING_RECONNECT_ATTEMPTS = 3;
const PAIRING_RECONNECT_DELAY_MS = 25;

function parseServerUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LocalPairingClientError("PAIRING_UNAVAILABLE");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(
    url.hostname.toLowerCase(),
  );
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new LocalPairingClientError("PAIRING_UNAVAILABLE");
  }
  return url;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function defaultRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function decodeMessageData(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer)
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  }
  throw new LocalPairingClientError("PAIRING_PROTOCOL_FAILED");
}

function parseStartResponse(value: unknown): PairingStartResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LocalPairingClientError("PAIRING_PROTOCOL_FAILED");
  }
  const record = value as Record<string, unknown>;
  const sessionId = pairingSessionIdSchema.safeParse(record.pairingSessionId);
  const pairingCode = record.pairingCode;
  const expiresAt = record.expiresAt;
  if (
    Object.keys(record).length !== 3 ||
    !sessionId.success ||
    typeof pairingCode !== "string" ||
    !/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(
      pairingCode,
    ) ||
    typeof expiresAt !== "string" ||
    !Number.isFinite(Date.parse(expiresAt))
  ) {
    throw new LocalPairingClientError("PAIRING_PROTOCOL_FAILED");
  }
  return {
    pairingSessionId: sessionId.data,
    pairingCode,
    expiresAt: new Date(expiresAt),
  };
}

function makeDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export class LocalPairingClient {
  readonly #options: LocalPairingClientOptions;
  readonly #fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  readonly #createWebSocket: (url: string) => PairingWebSocket;
  readonly #abortController = new AbortController();
  #credentialWaiter: ReturnType<
    typeof makeDeferred<LocalDeviceCredential>
  > | null = makeDeferred<LocalDeviceCredential>();
  #socket: PairingWebSocket | null = null;
  #socketUrl: string | null = null;
  #sessionId: string | null = null;
  #proof = "";
  #attachWaiter: ReturnType<typeof makeDeferred<void>> | null = null;
  #startPromise: Promise<void> | null = null;
  #reconnectPromise: Promise<void> | null = null;
  #removeSocketListeners: (() => void) | null = null;
  #attached = false;
  #completed = false;
  #closed = false;

  constructor(options: LocalPairingClientOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    const credentialWaiter = this.#credentialWaiter;
    if (credentialWaiter) void credentialWaiter.promise.catch(() => undefined);
    this.#createWebSocket =
      options.createWebSocket ?? ((url) => new WebSocket(url));
  }

  start(): Promise<void> {
    this.#startPromise ??= this.#start();
    return this.#startPromise;
  }

  waitForCredential(): Promise<LocalDeviceCredential> {
    return (
      this.#credentialWaiter?.promise ??
      this.#options.credentialProvider.load().then((credential) => {
        if (!credential)
          throw new LocalPairingClientError("PAIRING_UNAVAILABLE");
        return credential;
      })
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#abortController.abort();
    this.#attachWaiter?.reject(new LocalPairingClientError("PAIRING_CLOSED"));
    this.#attachWaiter = null;
    this.#proof = "";
    this.#socketUrl = null;
    this.#attached = false;
    this.#removeSocketListeners?.();
    this.#removeSocketListeners = null;
    this.#socket?.close(1000, "Pairing client closed");
    this.#socket = null;
    this.#sessionId = null;
    if (!this.#completed) {
      this.#credentialWaiter?.reject(
        new LocalPairingClientError("PAIRING_CLOSED"),
      );
    }
  }

  async #start(): Promise<void> {
    if (this.#closed) throw new LocalPairingClientError("PAIRING_CLOSED");
    const serverUrl = parseServerUrl(this.#options.serverUrl);
    const randomBytes = (this.#options.randomBytes ?? defaultRandomBytes)(32);
    if (!(randomBytes instanceof Uint8Array) || randomBytes.byteLength !== 32) {
      throw new LocalPairingClientError("PAIRING_UNAVAILABLE");
    }
    this.#proof = base64Url(randomBytes);
    const response = await this.#fetch(
      new URL("/pairing/sessions", serverUrl),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: this.#abortController.signal,
        body: JSON.stringify({
          deviceName: this.#options.deviceName,
          channelProof: this.#proof,
        }),
      },
    ).catch(() => {
      throw new LocalPairingClientError(
        this.#closed ? "PAIRING_CLOSED" : "PAIRING_UNAVAILABLE",
      );
    });
    if (this.#closed) throw new LocalPairingClientError("PAIRING_CLOSED");
    if (!response.ok) throw new LocalPairingClientError("PAIRING_UNAVAILABLE");

    let startResponse: PairingStartResponse;
    try {
      startResponse = parseStartResponse(await response.json());
    } catch (error) {
      if (error instanceof LocalPairingClientError) throw error;
      throw new LocalPairingClientError("PAIRING_PROTOCOL_FAILED");
    }
    if (this.#closed) throw new LocalPairingClientError("PAIRING_CLOSED");
    this.#sessionId = startResponse.pairingSessionId;
    const socketUrl = new URL("/pairing", serverUrl);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    this.#socketUrl = socketUrl.href;
    const socket = this.#createWebSocket(this.#socketUrl);
    this.#socket = socket;
    const attached = makeDeferred<void>();
    this.#attachWaiter = attached;
    const onOpen = (): void => {
      try {
        socket.send(
          JSON.stringify({
            kind: "pairing.attach",
            pairingSessionId: startResponse.pairingSessionId,
            channelProof: this.#proof,
          }),
        );
      } catch {
        attached.reject(new LocalPairingClientError("PAIRING_UNAVAILABLE"));
      }
    };
    const onMessage = (event: Event | MessageEvent): void => {
      void this.#handleMessage(event, attached, socket);
    };
    const onError = (): void => {
      if (this.#attached && !this.#completed && !this.#closed) {
        this.#attached = false;
        this.#removeSocketListeners?.();
        this.#removeSocketListeners = null;
        if (this.#socket === socket) this.#socket = null;
        socket.close(1011, "Pairing reconnect");
        this.#reconnect();
        return;
      }
      attached.reject(new LocalPairingClientError("PAIRING_UNAVAILABLE"));
      if (!this.#completed) {
        this.#credentialWaiter?.reject(
          new LocalPairingClientError("PAIRING_UNAVAILABLE"),
        );
      }
    };
    const onClose = (): void => {
      if (this.#socket === socket) this.#socket = null;
      if (this.#attached && !this.#completed && !this.#closed) {
        this.#attached = false;
        this.#removeSocketListeners?.();
        this.#removeSocketListeners = null;
        this.#reconnect();
        return;
      }
      if (!this.#completed) {
        const error = new LocalPairingClientError("PAIRING_CLOSED");
        attached.reject(error);
        this.#credentialWaiter?.reject(error);
      }
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    this.#removeSocketListeners = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    try {
      await attached.promise;
      if (this.#attachWaiter === attached) this.#attachWaiter = null;
      socket.removeEventListener("open", onOpen);
      this.#removeSocketListeners = () => {
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
      };
      this.#options.onPairingCode?.(
        startResponse.pairingCode,
        startResponse.expiresAt,
      );
      return;
    } catch (error) {
      if (this.#attachWaiter === attached) this.#attachWaiter = null;
      await this.close();
      throw error instanceof LocalPairingClientError
        ? error
        : new LocalPairingClientError("PAIRING_UNAVAILABLE");
    }
  }

  #reconnect(): void {
    if (
      this.#reconnectPromise ||
      this.#closed ||
      this.#completed ||
      !this.#sessionId ||
      !this.#proof ||
      !this.#socketUrl
    ) {
      return;
    }

    const reconnect = (async () => {
      let lastError = new LocalPairingClientError("PAIRING_UNAVAILABLE");
      for (
        let attempt = 0;
        attempt < MAX_PAIRING_RECONNECT_ATTEMPTS;
        attempt += 1
      ) {
        if (this.#closed || this.#completed) return;
        if (attempt > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, PAIRING_RECONNECT_DELAY_MS),
          );
          if (
            this.#closed ||
            this.#completed ||
            !this.#sessionId ||
            !this.#proof ||
            !this.#socketUrl
          ) {
            return;
          }
        }

        const socketUrl = this.#socketUrl;
        if (!socketUrl) return;
        const socket = this.#createWebSocket(socketUrl);
        this.#socket = socket;
        this.#attached = false;
        const attached = makeDeferred<void>();
        this.#attachWaiter = attached;

        const cleanup = (): void => {
          socket.removeEventListener("open", onOpen);
          socket.removeEventListener("message", onMessage);
          socket.removeEventListener("error", onError);
          socket.removeEventListener("close", onClose);
        };
        const retryOrReject = (error: LocalPairingClientError): void => {
          if (this.#attached && !this.#completed && !this.#closed) {
            this.#attached = false;
            cleanup();
            if (this.#socket === socket) this.#socket = null;
            this.#reconnectPromise = null;
            this.#reconnect();
            return;
          }
          attached.reject(error);
        };
        const onOpen = (): void => {
          try {
            socket.send(
              JSON.stringify({
                kind: "pairing.attach",
                pairingSessionId: this.#sessionId,
                channelProof: this.#proof,
              }),
            );
          } catch {
            retryOrReject(new LocalPairingClientError("PAIRING_UNAVAILABLE"));
          }
        };
        const onMessage = (event: Event | MessageEvent): void => {
          void this.#handleMessage(event, attached, socket);
        };
        const onError = (): void => {
          retryOrReject(new LocalPairingClientError("PAIRING_UNAVAILABLE"));
        };
        const onClose = (): void => {
          if (this.#socket === socket) this.#socket = null;
          retryOrReject(new LocalPairingClientError("PAIRING_CLOSED"));
        };

        socket.addEventListener("open", onOpen);
        socket.addEventListener("message", onMessage);
        socket.addEventListener("error", onError);
        socket.addEventListener("close", onClose);
        try {
          await attached.promise;
          if (this.#attachWaiter === attached) this.#attachWaiter = null;
          socket.removeEventListener("open", onOpen);
          this.#removeSocketListeners = () => {
            socket.removeEventListener("message", onMessage);
            socket.removeEventListener("error", onError);
            socket.removeEventListener("close", onClose);
          };
          return;
        } catch (error) {
          cleanup();
          if (this.#socket === socket) this.#socket = null;
          lastError =
            error instanceof LocalPairingClientError
              ? error
              : new LocalPairingClientError("PAIRING_UNAVAILABLE");
        }
      }

      if (!this.#closed && !this.#completed) {
        this.#credentialWaiter?.reject(lastError);
      }
    })();

    this.#reconnectPromise = reconnect.finally(() => {
      if (this.#reconnectPromise) this.#reconnectPromise = null;
    });
    void this.#reconnectPromise;
  }

  async #handleMessage(
    event: Event | MessageEvent,
    attached: ReturnType<typeof makeDeferred<void>>,
    sourceSocket: PairingWebSocket,
  ): Promise<void> {
    try {
      const data = decodeMessageData((event as MessageEvent).data);
      const parsedJson = JSON.parse(data) as unknown;
      const parsed = pairingChannelMessageSchema.safeParse(parsedJson);
      if (!parsed.success)
        throw new LocalPairingClientError("PAIRING_PROTOCOL_FAILED");
      const message = parsed.data;
      if (message.kind === "pairing.attached") {
        if (message.pairingSessionId !== this.#sessionId) {
          throw new LocalPairingClientError("PAIRING_PROTOCOL_FAILED");
        }
        this.#attached = true;
        attached.resolve();
        return;
      }
      if (message.kind === "pairing.error") {
        const code =
          message.code === "PAIRING_STORAGE_FAILED"
            ? "PAIRING_STORAGE_FAILED"
            : "PAIRING_UNAVAILABLE";
        throw new LocalPairingClientError(code);
      }
      if (message.kind === "pairing.close") {
        if (message.code !== "NORMAL") {
          throw new LocalPairingClientError("PAIRING_CLOSED");
        }
        return;
      }
      if (message.kind !== "pairing.credential") {
        throw new LocalPairingClientError("PAIRING_PROTOCOL_FAILED");
      }
      if (
        message.pairingSessionId !== this.#sessionId ||
        this.#completed ||
        this.#closed
      ) {
        throw new LocalPairingClientError("PAIRING_PROTOCOL_FAILED");
      }

      const credential: LocalDeviceCredential = {
        deviceId: message.deviceId,
        credential: message.credential,
      };
      try {
        await this.#options.credentialProvider.replace(credential);
      } catch {
        if (this.#socket === sourceSocket && sourceSocket.readyState === 1) {
          try {
            sourceSocket.send(
              JSON.stringify({
                kind: "pairing.error",
                code: "PAIRING_STORAGE_FAILED",
              }),
            );
          } catch {
            // Storage failure remains authoritative even if the socket is gone.
          }
        }
        throw new LocalPairingClientError("PAIRING_STORAGE_FAILED");
      }
      if (this.#closed) {
        throw new LocalPairingClientError("PAIRING_CLOSED");
      }
      if (
        this.#socket !== sourceSocket ||
        !this.#attached ||
        sourceSocket.readyState !== 1
      ) {
        // Credential is durable locally. The active/replacement socket will
        // receive the same pending delivery and perform its own matching ACK.
        return;
      }
      sourceSocket.send(
        JSON.stringify({
          kind: "pairing.ack",
          pairingSessionId: message.pairingSessionId,
          deviceId: message.deviceId,
          credentialId: message.credentialId,
          version: message.version,
        }),
      );
      this.#completed = true;
      this.#attached = false;
      this.#proof = "";
      this.#socketUrl = null;
      this.#sessionId = null;
      this.#removeSocketListeners?.();
      this.#removeSocketListeners = null;
      this.#credentialWaiter?.resolve(Object.freeze({ ...credential }));
      this.#credentialWaiter = null;
    } catch (error) {
      const safeError =
        error instanceof LocalPairingClientError
          ? error
          : new LocalPairingClientError("PAIRING_PROTOCOL_FAILED");
      attached.reject(safeError);
      if (this.#attachWaiter === attached) this.#attachWaiter = null;
      this.#credentialWaiter?.reject(safeError);
      this.#removeSocketListeners?.();
      this.#removeSocketListeners = null;
      this.#socket?.close(1008, "Pairing unavailable");
    }
  }
}
