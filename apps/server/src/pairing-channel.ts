import {
  type PairingChannelMessage,
  pairingChannelProofSchema,
} from "@doctmcp/protocol";
import { type PairingSession, pairingSessionIdSchema } from "@doctmcp/schemas";
import type { GatewayWebSocketConnection } from "./gateway";
import type {
  AcknowledgePairingCredentialDeliveryInput,
  CompletedPairingCredential,
} from "./pairing-credential-completion";

const CHANNEL_PROOF_DIGEST_PREFIX = "doctmcp-pairing-channel:v1\0";
export const DEFAULT_PAIRING_CHANNEL_MAX_PENDING = 256;
export const DEFAULT_PAIRING_DELIVERY_TIMEOUT_MS = 30_000;

export type PairingChannelErrorCode =
  | "PAIRING_UNAVAILABLE"
  | "PAIRING_RATE_LIMITED"
  | "PAIRING_STORAGE_FAILED"
  | "PROTOCOL_ERROR"
  | "TIMEOUT"
  | "SERVER_SHUTDOWN";

export class PairingChannelError extends Error {
  constructor(public readonly code: PairingChannelErrorCode) {
    super("Pairing channel is unavailable.");
    this.name = "PairingChannelError";
  }
}

export interface PairingChannelCoordinatorOptions {
  readonly acknowledgeDelivery: (
    input: AcknowledgePairingCredentialDeliveryInput,
  ) => Promise<void>;
  readonly cancelPairingSession?: (pairingSessionId: string) => Promise<void>;
  readonly forgetPendingCompletion?: (
    pairingSessionId: string,
    preserveDelivered: boolean,
  ) => void | Promise<void>;
  readonly now?: () => Date;
  readonly maxPendingSessions?: number;
  readonly deliveryTimeoutMs?: number;
}

interface DeliveryWaiter {
  readonly resolve: () => void;
  readonly reject: (error: PairingChannelError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PendingDelivery {
  readonly completed: CompletedPairingCredential;
  readonly waiters: Set<DeliveryWaiter>;
  sentSocketId: string | null;
  acknowledging: boolean;
}

interface PairingChannelEntry {
  readonly session: PairingSession;
  proofDigest: string;
  expiryTimer: ReturnType<typeof setTimeout>;
  deadlineMs: number;
  socket: GatewayWebSocketConnection | null;
  attaching: boolean;
  delivery: PendingDelivery | null;
}

function validatePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function readTimestamp(value: Date): number {
  const timestamp = value.getTime();
  if (!Number.isFinite(timestamp))
    throw new PairingChannelError("PAIRING_UNAVAILABLE");
  return timestamp;
}

async function digestProof(proof: string): Promise<string> {
  const bytes = new TextEncoder().encode(
    `${CHANNEL_PROOF_DIGEST_PREFIX}${proof}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== 64 || right.length !== 64) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function pairingFrame(value: PairingChannelMessage): string {
  return JSON.stringify(value);
}

export class PairingChannelCoordinator {
  readonly #acknowledgeDelivery: PairingChannelCoordinatorOptions["acknowledgeDelivery"];
  readonly #cancelPairingSession:
    | PairingChannelCoordinatorOptions["cancelPairingSession"]
    | undefined;
  readonly #forgetPendingCompletion:
    | PairingChannelCoordinatorOptions["forgetPendingCompletion"]
    | undefined;
  readonly #now: () => Date;
  readonly #maxPendingSessions: number;
  readonly #deliveryTimeoutMs: number;
  readonly #entries = new Map<string, PairingChannelEntry>();
  #closed = false;

  constructor(options: PairingChannelCoordinatorOptions) {
    this.#acknowledgeDelivery = options.acknowledgeDelivery;
    this.#cancelPairingSession = options.cancelPairingSession;
    this.#forgetPendingCompletion = options.forgetPendingCompletion;
    this.#now = options.now ?? (() => new Date());
    this.#maxPendingSessions = validatePositiveInteger(
      options.maxPendingSessions ?? DEFAULT_PAIRING_CHANNEL_MAX_PENDING,
      "maxPendingSessions",
    );
    this.#deliveryTimeoutMs = validatePositiveInteger(
      options.deliveryTimeoutMs ?? DEFAULT_PAIRING_DELIVERY_TIMEOUT_MS,
      "deliveryTimeoutMs",
    );
  }

  get pendingCount(): number {
    return this.#entries.size;
  }

  async register(session: PairingSession, proof: string): Promise<void> {
    this.#ensureOpen();
    const parsedProof = pairingChannelProofSchema.safeParse(proof);
    if (
      !parsedProof.success ||
      session.state !== "pending" ||
      session.claimedAt !== undefined ||
      session.deviceId !== undefined
    ) {
      throw new PairingChannelError("PAIRING_UNAVAILABLE");
    }

    const expiresAt = readTimestamp(session.expiresAt);
    if (expiresAt <= readTimestamp(this.#now())) {
      throw new PairingChannelError("PAIRING_UNAVAILABLE");
    }
    const proofDigest = await digestProof(parsedProof.data);
    this.#ensureOpen();
    this.#pruneExpired();
    if (
      expiresAt <= readTimestamp(this.#now()) ||
      this.#entries.has(session.pairingSessionId)
    ) {
      throw new PairingChannelError("PAIRING_UNAVAILABLE");
    }
    if (this.#entries.size >= this.#maxPendingSessions) {
      throw new PairingChannelError("PAIRING_RATE_LIMITED");
    }

    const pairingSessionId = session.pairingSessionId;
    const deadlineMs = expiresAt + this.#deliveryTimeoutMs;
    const entry: PairingChannelEntry = {
      session,
      proofDigest,
      expiryTimer: setTimeout(
        () => this.#expire(pairingSessionId),
        Math.max(0, deadlineMs - readTimestamp(this.#now())),
      ),
      deadlineMs,
      socket: null,
      attaching: false,
      delivery: null,
    };
    this.#entries.set(pairingSessionId, entry);
  }

  async attach(
    pairingSessionIdValue: string,
    proof: string,
    socket: GatewayWebSocketConnection,
  ): Promise<void> {
    this.#ensureOpen();
    const parsedSessionId = pairingSessionIdSchema.safeParse(
      pairingSessionIdValue,
    );
    const parsedProof = pairingChannelProofSchema.safeParse(proof);
    if (!parsedSessionId.success || !parsedProof.success) {
      throw new PairingChannelError("PAIRING_UNAVAILABLE");
    }
    const pairingSessionId = parsedSessionId.data;
    const entry = this.#liveEntry(pairingSessionId);
    if (entry.socket || entry.attaching) {
      throw new PairingChannelError("PAIRING_UNAVAILABLE");
    }

    entry.attaching = true;
    try {
      const proofDigest = await digestProof(parsedProof.data);
      if (
        this.#entries.get(pairingSessionId) !== entry ||
        !constantTimeHexEqual(entry.proofDigest, proofDigest)
      ) {
        throw new PairingChannelError("PAIRING_UNAVAILABLE");
      }
      entry.socket = socket;
      await socket.send(
        pairingFrame({
          kind: "pairing.attached",
          pairingSessionId,
          expiresAt: entry.session.expiresAt.toISOString(),
        }),
      );
      if (entry.delivery) await this.#sendPendingDelivery(entry, socket);
    } catch (error) {
      if (entry.socket === socket) entry.socket = null;
      if (error instanceof PairingChannelError) throw error;
      throw new PairingChannelError("PAIRING_UNAVAILABLE");
    } finally {
      entry.attaching = false;
    }
  }

  detach(
    pairingSessionIdValue: string,
    socket: GatewayWebSocketConnection,
  ): void {
    const parsedSessionId = pairingSessionIdSchema.safeParse(
      pairingSessionIdValue,
    );
    if (!parsedSessionId.success) return;
    const entry = this.#entries.get(parsedSessionId.data);
    if (!entry || entry.socket !== socket) return;
    entry.socket = null;
    if (entry.delivery?.sentSocketId === socket.id) {
      entry.delivery.sentSocketId = null;
    }
  }

  async cancel(
    pairingSessionIdValue: string,
    socket?: GatewayWebSocketConnection,
  ): Promise<void> {
    const parsedSessionId = pairingSessionIdSchema.safeParse(
      pairingSessionIdValue,
    );
    if (!parsedSessionId.success) {
      throw new PairingChannelError("PAIRING_UNAVAILABLE");
    }
    const entry = this.#entries.get(parsedSessionId.data);
    if (!entry || (socket && entry.socket !== socket)) {
      throw new PairingChannelError("PAIRING_UNAVAILABLE");
    }
    if (entry.session.state === "pending") {
      await this.#cancelPairingSession?.(entry.session.pairingSessionId).catch(
        () => undefined,
      );
    }
    if (entry.delivery) {
      this.#rejectWaiters(
        entry.delivery,
        new PairingChannelError("PAIRING_UNAVAILABLE"),
      );
    }
    entry.socket?.close(1000, "Pairing cancelled");
    this.#removeEntry(entry);
  }

  async deliver(completed: CompletedPairingCredential): Promise<void> {
    this.#ensureOpen();
    if (
      completed.session.state !== "claimed" ||
      completed.session.deviceId !== completed.device.deviceId
    ) {
      throw new PairingChannelError("PAIRING_UNAVAILABLE");
    }
    const claimedAt = completed.session.claimedAt;
    if (
      !claimedAt ||
      readTimestamp(claimedAt) >= readTimestamp(completed.session.expiresAt)
    ) {
      throw new PairingChannelError("PAIRING_UNAVAILABLE");
    }
    const entry = this.#liveEntry(completed.session.pairingSessionId);
    if (entry.session.pairingSessionId !== completed.session.pairingSessionId) {
      throw new PairingChannelError("PAIRING_UNAVAILABLE");
    }

    let delivery = entry.delivery;
    if (!delivery) {
      const deliveryDeadlineMs =
        readTimestamp(claimedAt) + this.#deliveryTimeoutMs;
      if (deliveryDeadlineMs <= readTimestamp(this.#now())) {
        this.#expire(entry.session.pairingSessionId);
        throw new PairingChannelError("TIMEOUT");
      }
      this.#setDeadline(entry, deliveryDeadlineMs);
      delivery = {
        completed,
        waiters: new Set(),
        sentSocketId: null,
        acknowledging: false,
      };
      entry.delivery = delivery;
    } else if (
      delivery.completed.credential.credentialId !==
        completed.credential.credentialId ||
      delivery.completed.credential.version !== completed.credential.version ||
      delivery.completed.secret !== completed.secret
    ) {
      throw new PairingChannelError("PAIRING_UNAVAILABLE");
    }

    const waiter = this.#createWaiter(delivery);
    if (entry.socket) await this.#sendPendingDelivery(entry, entry.socket);
    return waiter.promise;
  }

  async acknowledge(
    socket: GatewayWebSocketConnection,
    message: Extract<PairingChannelMessage, { kind: "pairing.ack" }>,
  ): Promise<void> {
    const entry = this.#liveEntry(message.pairingSessionId);
    const delivery = entry.delivery;
    const completed = delivery?.completed;
    if (
      !delivery ||
      !completed ||
      entry.socket !== socket ||
      delivery.acknowledging ||
      completed.device.deviceId !== message.deviceId ||
      completed.credential.credentialId !== message.credentialId ||
      completed.credential.version !== message.version
    ) {
      throw new PairingChannelError("PAIRING_UNAVAILABLE");
    }

    delivery.acknowledging = true;
    try {
      await this.#acknowledgeDelivery({
        pairingSessionId: completed.session.pairingSessionId,
        ownerId: completed.device.ownerId,
        credentialId: completed.credential.credentialId,
        credentialVersion: completed.credential.version,
      });
    } catch {
      delivery.acknowledging = false;
      this.#rejectWaiters(
        delivery,
        new PairingChannelError("PAIRING_UNAVAILABLE"),
      );
      throw new PairingChannelError("PAIRING_UNAVAILABLE");
    }

    const waiters = [...delivery.waiters];
    delivery.waiters.clear();
    this.#removeEntry(entry, true);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    try {
      await socket.send(
        pairingFrame({ kind: "pairing.close", code: "NORMAL" }),
      );
    } catch {
      // Local đã gửi ACK sau khi lưu credential; socket close vẫn hoàn tất cleanup.
    }
    socket.close(1000, "Pairing complete");
  }

  reportClientError(socket: GatewayWebSocketConnection): void {
    for (const entry of this.#entries.values()) {
      if (entry.socket !== socket || !entry.delivery) continue;
      this.#rejectWaiters(
        entry.delivery,
        new PairingChannelError("PAIRING_STORAGE_FAILED"),
      );
      return;
    }
    throw new PairingChannelError("PAIRING_UNAVAILABLE");
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const entries = [...this.#entries.values()];
    for (const entry of entries) {
      if (entry.session.state === "pending") {
        await this.#cancelPairingSession?.(
          entry.session.pairingSessionId,
        ).catch(() => undefined);
      }
      if (entry.delivery) {
        this.#rejectWaiters(
          entry.delivery,
          new PairingChannelError("SERVER_SHUTDOWN"),
        );
      }
      entry.socket?.close(1012, "Server shutdown");
      this.#removeEntry(entry);
    }
  }

  #createWaiter(delivery: PendingDelivery): { promise: Promise<void> } {
    let resolvePromise: () => void = () => undefined;
    let rejectPromise: (error: PairingChannelError) => void = () => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const waiter: DeliveryWaiter = {
      resolve: resolvePromise,
      reject: rejectPromise,
      timer: setTimeout(() => {
        delivery.waiters.delete(waiter);
        rejectPromise(new PairingChannelError("TIMEOUT"));
      }, this.#deliveryTimeoutMs),
    };
    delivery.waiters.add(waiter);
    return { promise };
  }

  async #sendPendingDelivery(
    entry: PairingChannelEntry,
    socket: GatewayWebSocketConnection,
  ): Promise<void> {
    const delivery = entry.delivery;
    if (
      !delivery ||
      entry.socket !== socket ||
      delivery.sentSocketId === socket.id
    ) {
      return;
    }
    delivery.sentSocketId = socket.id;
    const completed = delivery.completed;
    try {
      await socket.send(
        pairingFrame({
          kind: "pairing.credential",
          pairingSessionId: completed.session.pairingSessionId,
          deviceId: completed.device.deviceId,
          credentialId: completed.credential.credentialId,
          version: completed.credential.version,
          credential: completed.secret,
        }),
      );
    } catch {
      if (entry.socket === socket) entry.socket = null;
      if (delivery.sentSocketId === socket.id) delivery.sentSocketId = null;
    }
  }

  #liveEntry(pairingSessionIdValue: string): PairingChannelEntry {
    const parsedSessionId = pairingSessionIdSchema.safeParse(
      pairingSessionIdValue,
    );
    if (!parsedSessionId.success) {
      throw new PairingChannelError("PAIRING_UNAVAILABLE");
    }
    const entry = this.#entries.get(parsedSessionId.data);
    if (!entry) throw new PairingChannelError("PAIRING_UNAVAILABLE");
    if (entry.deadlineMs <= readTimestamp(this.#now())) {
      this.#expire(entry.session.pairingSessionId);
      throw new PairingChannelError("PAIRING_UNAVAILABLE");
    }
    return entry;
  }

  #pruneExpired(): void {
    const now = readTimestamp(this.#now());
    for (const entry of this.#entries.values()) {
      if (entry.deadlineMs <= now) {
        this.#expire(entry.session.pairingSessionId);
      }
    }
  }

  #expire(pairingSessionId: string): void {
    const entry = this.#entries.get(pairingSessionId);
    if (!entry) return;
    if (entry.delivery) {
      this.#rejectWaiters(entry.delivery, new PairingChannelError("TIMEOUT"));
    }
    entry.socket?.close(1000, "Pairing expired");
    this.#removeEntry(entry);
  }

  #setDeadline(entry: PairingChannelEntry, deadlineMs: number): void {
    clearTimeout(entry.expiryTimer);
    entry.deadlineMs = deadlineMs;
    entry.expiryTimer = setTimeout(
      () => this.#expire(entry.session.pairingSessionId),
      Math.max(0, deadlineMs - readTimestamp(this.#now())),
    );
  }

  #removeEntry(
    entry: PairingChannelEntry,
    preserveDeliveredCompletion = false,
  ): void {
    clearTimeout(entry.expiryTimer);
    this.#entries.delete(entry.session.pairingSessionId);
    void Promise.resolve(
      this.#forgetPendingCompletion?.(
        entry.session.pairingSessionId,
        preserveDeliveredCompletion,
      ),
    ).catch(() => undefined);
    entry.proofDigest = "";
    if (entry.delivery) {
      this.#rejectWaiters(
        entry.delivery,
        new PairingChannelError("PAIRING_UNAVAILABLE"),
      );
      entry.delivery = null;
    }
    entry.socket = null;
  }

  #rejectWaiters(delivery: PendingDelivery, error: PairingChannelError): void {
    const waiters = [...delivery.waiters];
    delivery.waiters.clear();
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  #ensureOpen(): void {
    if (this.#closed) throw new PairingChannelError("SERVER_SHUTDOWN");
  }
}
