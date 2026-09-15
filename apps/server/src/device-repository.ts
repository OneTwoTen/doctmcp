import {
  createDeviceInputSchema,
  deviceIdSchema,
  ownerIdSchema,
  updateDeviceInputSchema,
  type CreateDeviceInput,
  type Device,
  type DeviceMetadata,
  type UpdateDeviceInput,
} from "@doctmcp/schemas";

export type DeviceRepositoryErrorCode =
  | "INVALID_DEVICE_INPUT"
  | "INVALID_DEVICE_ID"
  | "DEVICE_ALREADY_EXISTS";

export class DeviceRepositoryError extends Error {
  constructor(
    public readonly code: DeviceRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DeviceRepositoryError";
  }
}

export type DeviceIdGenerator = () => string;
export type DeviceClock = () => Date;

export interface DeviceRepository {
  create(input: CreateDeviceInput): Promise<Device>;
  getById(deviceId: string): Promise<Device | null>;
  getForOwner(ownerId: string, deviceId: string): Promise<Device | null>;
  listByOwnerId(ownerId: string): Promise<readonly Device[]>;
  updateForOwner(
    ownerId: string,
    deviceId: string,
    patch: UpdateDeviceInput,
  ): Promise<Device | null>;
  isOwnedBy(ownerId: string, deviceId: string): Promise<boolean>;
}

export interface InMemoryDeviceRepositoryOptions {
  generateDeviceId?: DeviceIdGenerator;
  now?: DeviceClock;
}

interface StoredDevice {
  readonly deviceId: string;
  readonly ownerId: string;
  deviceName: string;
  metadata: DeviceMetadata;
  readonly createdAtMs: number;
  updatedAtMs: number;
}

function invalidInput(message: string): never {
  throw new DeviceRepositoryError("INVALID_DEVICE_INPUT", message);
}

function parseOwnerId(ownerId: string): string {
  const result = ownerIdSchema.safeParse(ownerId);
  if (!result.success) {
    return invalidInput("ownerId không hợp lệ.");
  }
  return result.data;
}

function parseDeviceId(deviceId: string): string {
  const result = deviceIdSchema.safeParse(deviceId);
  if (!result.success) {
    return invalidInput("deviceId không hợp lệ.");
  }
  return result.data;
}

function cloneMetadata(metadata: DeviceMetadata): DeviceMetadata {
  return Object.freeze({ ...metadata });
}

function toSnapshot(record: StoredDevice): Device {
  return Object.freeze({
    deviceId: record.deviceId,
    ownerId: record.ownerId,
    deviceName: record.deviceName,
    metadata: cloneMetadata(record.metadata),
    createdAt: new Date(record.createdAtMs),
    updatedAt: new Date(record.updatedAtMs),
  });
}

export class InMemoryDeviceRepository implements DeviceRepository {
  readonly #records = new Map<string, StoredDevice>();
  readonly #generateDeviceId: DeviceIdGenerator;
  readonly #now: DeviceClock;

  constructor(options: InMemoryDeviceRepositoryOptions = {}) {
    this.#generateDeviceId =
      options.generateDeviceId ?? (() => globalThis.crypto.randomUUID());
    this.#now = options.now ?? (() => new Date());
  }

  async create(input: CreateDeviceInput): Promise<Device> {
    const parsedInput = createDeviceInputSchema.safeParse(input);
    if (!parsedInput.success) {
      return invalidInput("Device input không hợp lệ.");
    }

    const generatedId = this.#generateDeviceId();
    const parsedId = deviceIdSchema.safeParse(generatedId);
    if (!parsedId.success) {
      throw new DeviceRepositoryError(
        "INVALID_DEVICE_ID",
        "Device id generator trả về id không hợp lệ.",
      );
    }

    if (this.#records.has(parsedId.data)) {
      throw new DeviceRepositoryError(
        "DEVICE_ALREADY_EXISTS",
        "deviceId đã tồn tại.",
      );
    }

    const nowMs = this.#readNow();
    const record: StoredDevice = {
      deviceId: parsedId.data,
      ownerId: parsedInput.data.ownerId,
      deviceName: parsedInput.data.deviceName,
      metadata: cloneMetadata(parsedInput.data.metadata),
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };

    this.#records.set(record.deviceId, record);
    return toSnapshot(record);
  }

  async getById(deviceId: string): Promise<Device | null> {
    const parsedDeviceId = parseDeviceId(deviceId);
    const record = this.#records.get(parsedDeviceId);
    return record ? toSnapshot(record) : null;
  }

  async getForOwner(
    ownerId: string,
    deviceId: string,
  ): Promise<Device | null> {
    const parsedOwnerId = parseOwnerId(ownerId);
    const parsedDeviceId = parseDeviceId(deviceId);
    const record = this.#records.get(parsedDeviceId);

    if (!record || record.ownerId !== parsedOwnerId) {
      return null;
    }

    return toSnapshot(record);
  }

  async listByOwnerId(ownerId: string): Promise<readonly Device[]> {
    const parsedOwnerId = parseOwnerId(ownerId);
    const devices = [...this.#records.values()]
      .filter((record) => record.ownerId === parsedOwnerId)
      .sort(
        (left, right) =>
          left.createdAtMs - right.createdAtMs ||
          left.deviceId.localeCompare(right.deviceId),
      )
      .map(toSnapshot);

    return Object.freeze(devices);
  }

  async updateForOwner(
    ownerId: string,
    deviceId: string,
    patch: UpdateDeviceInput,
  ): Promise<Device | null> {
    const parsedOwnerId = parseOwnerId(ownerId);
    const parsedDeviceId = parseDeviceId(deviceId);
    const parsedPatch = updateDeviceInputSchema.safeParse(patch);
    if (!parsedPatch.success) {
      return invalidInput("Device update không hợp lệ.");
    }

    const record = this.#records.get(parsedDeviceId);
    if (!record || record.ownerId !== parsedOwnerId) {
      return null;
    }

    if (parsedPatch.data.deviceName !== undefined) {
      record.deviceName = parsedPatch.data.deviceName;
    }
    if (parsedPatch.data.metadata !== undefined) {
      record.metadata = cloneMetadata(parsedPatch.data.metadata);
    }
    record.updatedAtMs = this.#readNow();

    return toSnapshot(record);
  }

  async isOwnedBy(ownerId: string, deviceId: string): Promise<boolean> {
    const parsedOwnerId = parseOwnerId(ownerId);
    const parsedDeviceId = parseDeviceId(deviceId);
    return this.#records.get(parsedDeviceId)?.ownerId === parsedOwnerId;
  }

  #readNow(): number {
    const now = this.#now();
    const timestamp = now.getTime();
    if (Number.isNaN(timestamp)) {
      return invalidInput("Clock trả về thời điểm không hợp lệ.");
    }
    return timestamp;
  }
}
