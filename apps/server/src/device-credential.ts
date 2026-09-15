import {
  type AuthenticatedDeviceIdentity,
  type DeviceCredential,
  deviceCredentialIdSchema,
  deviceCredentialSchema,
  deviceIdSchema,
} from "@doctmcp/schemas";
import type { DeviceRepository } from "./device-repository";

export const DEVICE_CREDENTIAL_SECRET_BYTES = 32;
export const DEVICE_CREDENTIAL_ENTROPY_BITS = 256;
const DEVICE_CREDENTIAL_DIGEST_PREFIX = "doctmcp-device-credential:v1:";
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export type DeviceCredentialClock = () => Date;
export type DeviceCredentialIdGenerator = () => string;
export type DeviceCredentialSecretGenerator = () => string;

export interface IssuedDeviceCredential {
  readonly credential: DeviceCredential;
  readonly secret: string;
}

export interface VerifiedDeviceCredential {
  readonly credential: DeviceCredential;
  readonly identity: AuthenticatedDeviceIdentity;
}

export type DeviceCredentialErrorCode =
  | "INVALID_CREDENTIAL_INPUT"
  | "INVALID_CLOCK"
  | "DEVICE_NOT_FOUND"
  | "CREDENTIAL_ALREADY_EXISTS"
  | "CREDENTIAL_ID_CONFLICT"
  | "CREDENTIAL_UNAVAILABLE";

export class DeviceCredentialError extends Error {
  constructor(
    public readonly code: DeviceCredentialErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DeviceCredentialError";
  }
}

interface StoredCredential {
  readonly credentialId: string;
  readonly deviceId: string;
  readonly version: number;
  readonly secretDigest: string;
  readonly createdAtMs: number;
  state: "active" | "revoked";
  revokedAtMs?: number;
}

export interface DeviceCredentialRepository {
  issue(input: {
    readonly deviceId: string;
    readonly credentialId: string;
    readonly secretDigest: string;
    readonly createdAt: Date;
  }): Promise<DeviceCredential>;
  getActive(deviceId: string): Promise<DeviceCredential | null>;
  verify(
    deviceId: string,
    secretDigest: string,
  ): Promise<DeviceCredential | null>;
  revoke(input: {
    readonly deviceId: string;
    readonly expectedCredentialId: string;
    readonly expectedVersion: number;
    readonly revokedAt: Date;
  }): Promise<DeviceCredential | null>;
  rotate(input: {
    readonly deviceId: string;
    readonly expectedCredentialId: string;
    readonly expectedVersion: number;
    readonly credentialId: string;
    readonly secretDigest: string;
    readonly rotatedAt: Date;
  }): Promise<DeviceCredential>;
}

function fail(code: DeviceCredentialErrorCode, message: string): never {
  throw new DeviceCredentialError(code, message);
}

function readTime(value: Date): number {
  const timestamp = value.getTime();
  if (!Number.isFinite(timestamp)) {
    return fail("INVALID_CLOCK", "Credential clock không hợp lệ.");
  }
  return timestamp;
}

function parseDeviceId(value: string): string {
  const parsed = deviceIdSchema.safeParse(value);
  if (!parsed.success) {
    return fail("INVALID_CREDENTIAL_INPUT", "deviceId không hợp lệ.");
  }
  return parsed.data;
}

function parseCredentialId(value: string): string {
  const parsed = deviceCredentialIdSchema.safeParse(value);
  if (!parsed.success) {
    return fail("INVALID_CREDENTIAL_INPUT", "credentialId không hợp lệ.");
  }
  return parsed.data;
}

function parseVersion(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    return fail("INVALID_CREDENTIAL_INPUT", "Credential version không hợp lệ.");
  }
  return value;
}

function parseDigest(value: string): string {
  if (!DIGEST_PATTERN.test(value)) {
    return fail("INVALID_CREDENTIAL_INPUT", "Credential digest không hợp lệ.");
  }
  return value;
}

function snapshot(record: StoredCredential): DeviceCredential {
  const parsed = deviceCredentialSchema.safeParse({
    credentialId: record.credentialId,
    version: record.version,
    deviceId: record.deviceId,
    state: record.state,
    createdAt: new Date(record.createdAtMs),
    ...(record.revokedAtMs !== undefined
      ? { revokedAt: new Date(record.revokedAtMs) }
      : {}),
  });
  if (!parsed.success) {
    return fail("INVALID_CREDENTIAL_INPUT", "Credential record không hợp lệ.");
  }
  return Object.freeze(parsed.data);
}

export class InMemoryDeviceCredentialRepository
  implements DeviceCredentialRepository
{
  readonly #byDeviceId = new Map<string, StoredCredential>();
  readonly #usedCredentialIds = new Set<string>();
  #tail: Promise<void> = Promise.resolve();

  async issue(input: {
    readonly deviceId: string;
    readonly credentialId: string;
    readonly secretDigest: string;
    readonly createdAt: Date;
  }): Promise<DeviceCredential> {
    const deviceId = parseDeviceId(input.deviceId);
    const credentialId = parseCredentialId(input.credentialId);
    const secretDigest = parseDigest(input.secretDigest);
    const createdAtMs = readTime(input.createdAt);

    return this.#exclusive(async () => {
      const existing = this.#byDeviceId.get(deviceId);
      if (existing?.state === "active") {
        return fail(
          "CREDENTIAL_ALREADY_EXISTS",
          "Device đã có credential active.",
        );
      }
      this.#requireUnusedCredentialId(credentialId);
      const version = (existing?.version ?? 0) + 1;
      const record: StoredCredential = {
        credentialId,
        deviceId,
        version,
        secretDigest,
        createdAtMs,
        state: "active",
      };
      const result = snapshot(record);
      this.#byDeviceId.set(deviceId, record);
      this.#usedCredentialIds.add(credentialId);
      return result;
    });
  }

  async getActive(deviceId: string): Promise<DeviceCredential | null> {
    const parsedDeviceId = parseDeviceId(deviceId);
    const record = this.#byDeviceId.get(parsedDeviceId);
    return record?.state === "active" ? snapshot(record) : null;
  }

  async verify(
    deviceId: string,
    secretDigest: string,
  ): Promise<DeviceCredential | null> {
    const parsedDeviceId = parseDeviceId(deviceId);
    const parsedDigest = parseDigest(secretDigest);
    const record = this.#byDeviceId.get(parsedDeviceId);
    if (
      record?.state !== "active" ||
      !constantTimeEqualHex(record.secretDigest, parsedDigest)
    ) {
      return null;
    }
    return snapshot(record);
  }

  async revoke(input: {
    readonly deviceId: string;
    readonly expectedCredentialId: string;
    readonly expectedVersion: number;
    readonly revokedAt: Date;
  }): Promise<DeviceCredential | null> {
    const deviceId = parseDeviceId(input.deviceId);
    const expectedCredentialId = parseCredentialId(input.expectedCredentialId);
    const expectedVersion = parseVersion(input.expectedVersion);
    const revokedAtMs = readTime(input.revokedAt);
    return this.#exclusive(async () => {
      const record = this.#byDeviceId.get(deviceId);
      if (
        record?.state !== "active" ||
        record.credentialId !== expectedCredentialId ||
        record.version !== expectedVersion
      ) {
        return null;
      }
      if (revokedAtMs < record.createdAtMs) {
        return fail("INVALID_CLOCK", "revokedAt không được trước createdAt.");
      }
      record.state = "revoked";
      record.revokedAtMs = revokedAtMs;
      return snapshot(record);
    });
  }

  async rotate(input: {
    readonly deviceId: string;
    readonly expectedCredentialId: string;
    readonly expectedVersion: number;
    readonly credentialId: string;
    readonly secretDigest: string;
    readonly rotatedAt: Date;
  }): Promise<DeviceCredential> {
    const deviceId = parseDeviceId(input.deviceId);
    const expectedCredentialId = parseCredentialId(input.expectedCredentialId);
    const expectedVersion = parseVersion(input.expectedVersion);
    const credentialId = parseCredentialId(input.credentialId);
    const secretDigest = parseDigest(input.secretDigest);
    const rotatedAtMs = readTime(input.rotatedAt);

    return this.#exclusive(async () => {
      const current = this.#byDeviceId.get(deviceId);
      if (
        current?.state !== "active" ||
        current.credentialId !== expectedCredentialId ||
        current.version !== expectedVersion
      ) {
        return fail("CREDENTIAL_UNAVAILABLE", "Credential không khả dụng.");
      }
      this.#requireUnusedCredentialId(credentialId);
      if (rotatedAtMs < current.createdAtMs) {
        return fail("INVALID_CLOCK", "rotatedAt không được trước createdAt.");
      }
      const next: StoredCredential = {
        credentialId,
        deviceId,
        version: current.version + 1,
        secretDigest,
        createdAtMs: rotatedAtMs,
        state: "active",
      };
      const result = snapshot(next);
      this.#byDeviceId.set(deviceId, next);
      this.#usedCredentialIds.add(credentialId);
      return result;
    });
  }

  #requireUnusedCredentialId(credentialId: string): void {
    if (this.#usedCredentialIds.has(credentialId)) {
      fail("CREDENTIAL_ID_CONFLICT", "credentialId đã được sử dụng.");
    }
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release: () => void = () => undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export interface DeviceCredentialServiceOptions {
  readonly repository: DeviceCredentialRepository;
  readonly deviceRepository: DeviceRepository;
  readonly now?: DeviceCredentialClock;
  readonly generateCredentialId?: DeviceCredentialIdGenerator;
  readonly generateSecret?: DeviceCredentialSecretGenerator;
}

export class DeviceCredentialService {
  readonly #repository: DeviceCredentialRepository;
  readonly #deviceRepository: DeviceRepository;
  readonly #now: DeviceCredentialClock;
  readonly #generateCredentialId: DeviceCredentialIdGenerator;
  readonly #generateSecret: DeviceCredentialSecretGenerator;

  constructor(options: DeviceCredentialServiceOptions) {
    this.#repository = options.repository;
    this.#deviceRepository = options.deviceRepository;
    this.#now = options.now ?? (() => new Date());
    this.#generateCredentialId =
      options.generateCredentialId ?? (() => globalThis.crypto.randomUUID());
    this.#generateSecret =
      options.generateSecret ?? generateDeviceCredentialSecret;
  }

  async issue(deviceId: string): Promise<IssuedDeviceCredential> {
    const device = await this.#requireDevice(deviceId);
    const secret = this.#generateSecret();
    const secretDigest = await digestDeviceCredentialSecret(secret);
    const credential = await this.#repository.issue({
      deviceId: device.deviceId,
      credentialId: this.#generateCredentialId(),
      secretDigest,
      createdAt: this.#readNow(),
    });
    return Object.freeze({ credential, secret });
  }

  async verify(
    deviceId: unknown,
    secret: unknown,
  ): Promise<VerifiedDeviceCredential> {
    if (typeof deviceId !== "string" || typeof secret !== "string" || !secret) {
      throw unavailable();
    }
    const parsedId = deviceIdSchema.safeParse(deviceId);
    if (!parsedId.success) throw unavailable();
    const device = await this.#deviceRepository.getById(parsedId.data);
    if (!device) throw unavailable();
    const digest = await digestDeviceCredentialSecret(secret);
    const credential = await this.#repository.verify(device.deviceId, digest);
    if (!credential) throw unavailable();
    return Object.freeze({
      credential,
      identity: Object.freeze({
        ownerId: device.ownerId,
        deviceId: device.deviceId,
      }),
    });
  }

  async revoke(deviceId: string): Promise<DeviceCredential> {
    const device = await this.#requireDevice(deviceId);
    const current = await this.#requireActiveCredential(device.deviceId);
    const revoked = await this.#repository.revoke({
      deviceId: device.deviceId,
      expectedCredentialId: current.credentialId,
      expectedVersion: current.version,
      revokedAt: this.#readNow(),
    });
    if (!revoked) throw unavailable();
    return revoked;
  }

  async rotate(deviceId: string): Promise<IssuedDeviceCredential> {
    const device = await this.#requireDevice(deviceId);
    const current = await this.#requireActiveCredential(device.deviceId);
    const secret = this.#generateSecret();
    const digest = await digestDeviceCredentialSecret(secret);
    const credential = await this.#repository.rotate({
      deviceId: device.deviceId,
      expectedCredentialId: current.credentialId,
      expectedVersion: current.version,
      credentialId: this.#generateCredentialId(),
      secretDigest: digest,
      rotatedAt: this.#readNow(),
    });
    return Object.freeze({ credential, secret });
  }

  async #requireActiveCredential(deviceId: string): Promise<DeviceCredential> {
    const credential = await this.#repository.getActive(deviceId);
    if (!credential) throw unavailable();
    return credential;
  }

  async #requireDevice(deviceId: string) {
    const parsed = deviceIdSchema.safeParse(deviceId);
    if (!parsed.success) {
      return fail("INVALID_CREDENTIAL_INPUT", "deviceId không hợp lệ.");
    }
    const device = await this.#deviceRepository.getById(parsed.data);
    if (!device) return fail("DEVICE_NOT_FOUND", "Device không tồn tại.");
    return device;
  }

  #readNow(): Date {
    const value = this.#now();
    if (!Number.isFinite(value.getTime())) {
      return fail("INVALID_CLOCK", "Credential clock không hợp lệ.");
    }
    return new Date(value.getTime());
  }
}

function unavailable(): DeviceCredentialError {
  return new DeviceCredentialError(
    "CREDENTIAL_UNAVAILABLE",
    "Device credential không khả dụng.",
  );
}

export function generateDeviceCredentialSecret(): string {
  const bytes = new Uint8Array(DEVICE_CREDENTIAL_SECRET_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

export async function digestDeviceCredentialSecret(
  secret: string,
): Promise<string> {
  const encoded = new TextEncoder().encode(
    `${DEVICE_CREDENTIAL_DIGEST_PREFIX}${secret}`,
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function constantTimeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}
