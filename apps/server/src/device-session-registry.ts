import type { BridgeGatewaySession } from "./gateway";

export const DEFAULT_DEVICE_HEARTBEAT_INTERVAL_MS = 1_000;
export const DEFAULT_DEVICE_HEARTBEAT_TIMEOUT_MS = 4_000;

export interface DeviceSessionCredentialGeneration {
  readonly credentialId: string;
  readonly credentialVersion: number;
}

export interface ActiveDeviceSession {
  readonly registrationId: string;
  readonly ownerId: string;
  readonly deviceId: string;
  readonly credentialGeneration: DeviceSessionCredentialGeneration;
  readonly connectedAt: Date;
  readonly lastSeenAt: Date;
  readonly session: BridgeGatewaySession;
}

export interface DeviceSessionStatusSnapshot {
  readonly deviceId: string;
  readonly status: "online" | "offline";
  readonly connectedAt: Date | null;
  readonly lastSeenAt: Date | null;
}

export interface RegisterDeviceSessionResult {
  readonly current: ActiveDeviceSession;
  readonly replaced: ActiveDeviceSession | null;
}

export interface DeviceSessionRegistryOptions {
  readonly heartbeatTimeoutMs?: number;
  readonly now?: () => Date;
  readonly generateRegistrationId?: () => string;
}

interface StoredDeviceSession {
  readonly registrationId: string;
  readonly ownerId: string;
  readonly deviceId: string;
  readonly credentialGeneration: DeviceSessionCredentialGeneration;
  readonly connectedAtMs: number;
  lastSeenAtMs: number;
  readonly session: BridgeGatewaySession;
}

interface SessionRegistrationRef {
  readonly deviceId: string;
  readonly registrationId: string;
}

function cloneGeneration(
  generation: DeviceSessionCredentialGeneration,
): DeviceSessionCredentialGeneration {
  if (
    !generation.credentialId ||
    !Number.isInteger(generation.credentialVersion) ||
    generation.credentialVersion <= 0
  ) {
    throw new Error("Device session credential generation không hợp lệ.");
  }
  return Object.freeze({
    credentialId: generation.credentialId,
    credentialVersion: generation.credentialVersion,
  });
}

function snapshot(entry: StoredDeviceSession): ActiveDeviceSession {
  return Object.freeze({
    registrationId: entry.registrationId,
    ownerId: entry.ownerId,
    deviceId: entry.deviceId,
    credentialGeneration: cloneGeneration(entry.credentialGeneration),
    connectedAt: new Date(entry.connectedAtMs),
    lastSeenAt: new Date(entry.lastSeenAtMs),
    session: entry.session,
  });
}

export class DeviceSessionRegistry {
  readonly #byDeviceId = new Map<string, StoredDeviceSession>();
  readonly #deviceIdsByOwner = new Map<string, Set<string>>();
  readonly #registrationBySession = new Map<
    BridgeGatewaySession,
    SessionRegistrationRef
  >();
  readonly #heartbeatTimeoutMs: number;
  readonly #now: () => Date;
  readonly #generateRegistrationId: () => string;

  constructor(options: DeviceSessionRegistryOptions = {}) {
    const heartbeatTimeoutMs =
      options.heartbeatTimeoutMs ?? DEFAULT_DEVICE_HEARTBEAT_TIMEOUT_MS;
    if (!Number.isFinite(heartbeatTimeoutMs) || heartbeatTimeoutMs <= 0) {
      throw new Error("heartbeatTimeoutMs phải là số dương hữu hạn.");
    }
    this.#heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.#now = options.now ?? (() => new Date());
    this.#generateRegistrationId =
      options.generateRegistrationId ?? (() => globalThis.crypto.randomUUID());
  }

  get heartbeatTimeoutMs(): number {
    return this.#heartbeatTimeoutMs;
  }

  get size(): number {
    return this.#byDeviceId.size;
  }

  register(
    session: BridgeGatewaySession,
    credentialGeneration: DeviceSessionCredentialGeneration,
  ): RegisterDeviceSessionResult {
    const identity = session.identity;
    if (!identity) {
      throw new Error("Chỉ authenticated device session mới được register.");
    }
    if (session.state !== "ready") {
      throw new Error("Chỉ ready device session mới được register.");
    }

    const existingRef = this.#registrationBySession.get(session);
    if (existingRef) {
      const existing = this.#byDeviceId.get(existingRef.deviceId);
      if (
        existing &&
        existing.registrationId === existingRef.registrationId &&
        existing.session === session
      ) {
        return Object.freeze({ current: snapshot(existing), replaced: null });
      }
      this.#registrationBySession.delete(session);
    }

    const nowMs = this.#readNowMs();
    const current: StoredDeviceSession = {
      registrationId: this.#generateRegistrationId(),
      ownerId: identity.ownerId,
      deviceId: identity.deviceId,
      credentialGeneration: cloneGeneration(credentialGeneration),
      connectedAtMs: nowMs,
      lastSeenAtMs: nowMs,
      session,
    };

    const previous = this.#byDeviceId.get(identity.deviceId) ?? null;
    this.#byDeviceId.set(identity.deviceId, current);
    this.#registrationBySession.set(session, {
      deviceId: identity.deviceId,
      registrationId: current.registrationId,
    });
    this.#addOwnerDevice(identity.ownerId, identity.deviceId);

    if (previous) {
      this.#registrationBySession.delete(previous.session);
      if (previous.ownerId !== identity.ownerId) {
        this.#removeOwnerDevice(previous.ownerId, previous.deviceId);
      }
    }

    return Object.freeze({
      current: snapshot(current),
      replaced: previous ? snapshot(previous) : null,
    });
  }

  getActive(deviceId: string): ActiveDeviceSession | null {
    const entry = this.#byDeviceId.get(deviceId);
    if (!entry || !this.#isLive(entry, this.#readNowMs())) return null;
    return snapshot(entry);
  }

  getBySession(session: BridgeGatewaySession): ActiveDeviceSession | null {
    const ref = this.#registrationBySession.get(session);
    if (!ref) return null;
    const entry = this.#byDeviceId.get(ref.deviceId);
    if (
      !entry ||
      entry.registrationId !== ref.registrationId ||
      entry.session !== session
    ) {
      this.#registrationBySession.delete(session);
      return null;
    }
    return snapshot(entry);
  }

  listActiveForOwner(ownerId: string): readonly ActiveDeviceSession[] {
    const deviceIds = this.#deviceIdsByOwner.get(ownerId);
    if (!deviceIds) return Object.freeze([]);
    const nowMs = this.#readNowMs();
    const sessions: ActiveDeviceSession[] = [];
    for (const deviceId of deviceIds) {
      const entry = this.#byDeviceId.get(deviceId);
      if (entry && this.#isLive(entry, nowMs)) sessions.push(snapshot(entry));
    }
    return Object.freeze(sessions);
  }

  markHeartbeat(session: BridgeGatewaySession): boolean {
    const ref = this.#registrationBySession.get(session);
    if (!ref) return false;
    const entry = this.#byDeviceId.get(ref.deviceId);
    if (
      !entry ||
      entry.registrationId !== ref.registrationId ||
      entry.session !== session
    ) {
      this.#registrationBySession.delete(session);
      return false;
    }

    const nowMs = this.#readNowMs();
    if (!this.#isLive(entry, nowMs)) return false;

    entry.lastSeenAtMs = Math.max(entry.lastSeenAtMs, nowMs);
    return true;
  }

  evictSession(session: BridgeGatewaySession): ActiveDeviceSession | null {
    const ref = this.#registrationBySession.get(session);
    if (!ref) return null;
    this.#registrationBySession.delete(session);
    const entry = this.#byDeviceId.get(ref.deviceId);
    if (
      !entry ||
      entry.registrationId !== ref.registrationId ||
      entry.session !== session
    ) {
      return null;
    }
    this.#remove(entry);
    return snapshot(entry);
  }

  evictGeneration(
    deviceId: string,
    generation: DeviceSessionCredentialGeneration,
  ): ActiveDeviceSession | null {
    const entry = this.#byDeviceId.get(deviceId);
    if (!entry) return null;
    if (
      entry.credentialGeneration.credentialId !== generation.credentialId ||
      entry.credentialGeneration.credentialVersion !==
        generation.credentialVersion
    ) {
      return null;
    }
    this.#remove(entry);
    return snapshot(entry);
  }

  getStatus(deviceId: string): DeviceSessionStatusSnapshot {
    const entry = this.#byDeviceId.get(deviceId);
    if (!entry) {
      return Object.freeze({
        deviceId,
        status: "offline" as const,
        connectedAt: null,
        lastSeenAt: null,
      });
    }
    return Object.freeze({
      deviceId,
      status: this.#isLive(entry, this.#readNowMs())
        ? ("online" as const)
        : ("offline" as const),
      connectedAt: new Date(entry.connectedAtMs),
      lastSeenAt: new Date(entry.lastSeenAtMs),
    });
  }

  clear(): readonly ActiveDeviceSession[] {
    const entries = [...this.#byDeviceId.values()].map(snapshot);
    this.#byDeviceId.clear();
    this.#deviceIdsByOwner.clear();
    this.#registrationBySession.clear();
    return Object.freeze(entries);
  }

  #isLive(entry: StoredDeviceSession, nowMs: number): boolean {
    if (entry.session.state !== "ready") return false;
    return nowMs - entry.lastSeenAtMs < this.#heartbeatTimeoutMs;
  }

  #addOwnerDevice(ownerId: string, deviceId: string): void {
    const deviceIds = this.#deviceIdsByOwner.get(ownerId) ?? new Set<string>();
    deviceIds.add(deviceId);
    this.#deviceIdsByOwner.set(ownerId, deviceIds);
  }

  #removeOwnerDevice(ownerId: string, deviceId: string): void {
    const deviceIds = this.#deviceIdsByOwner.get(ownerId);
    if (!deviceIds) return;
    deviceIds.delete(deviceId);
    if (deviceIds.size === 0) this.#deviceIdsByOwner.delete(ownerId);
  }

  #remove(entry: StoredDeviceSession): void {
    const current = this.#byDeviceId.get(entry.deviceId);
    if (current?.registrationId !== entry.registrationId) return;
    this.#byDeviceId.delete(entry.deviceId);
    this.#registrationBySession.delete(entry.session);
    this.#removeOwnerDevice(entry.ownerId, entry.deviceId);
  }

  #readNowMs(): number {
    const now = this.#now().getTime();
    if (!Number.isFinite(now))
      throw new Error("Device session clock không hợp lệ.");
    return now;
  }
}
