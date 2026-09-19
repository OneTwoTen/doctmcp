import { type Device, deviceIdSchema, ownerIdSchema } from "@doctmcp/schemas";
import type { DeviceCredentialRepository } from "./device-credential";
import type { DeviceRepository } from "./device-repository";
import type { DeviceSessionRegistry } from "./device-session-registry";
import type { BridgeGatewaySession } from "./gateway";

export type DeviceRoutingErrorCode =
  | "DEVICE_NOT_FOUND"
  | "DEVICE_OFFLINE"
  | "DEVICE_CREDENTIAL_UNAVAILABLE"
  | "ROUTING_UNAVAILABLE";

export class DeviceRoutingError extends Error {
  constructor(
    public readonly code: DeviceRoutingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DeviceRoutingError";
  }
}

export interface RoutedDeviceSnapshot extends Omit<Device, "ownerId"> {
  readonly status: "online" | "offline";
  readonly connectedAt: Date | null;
  readonly lastSeenAt: Date | null;
}

export interface ResolvedDeviceSession {
  readonly device: RoutedDeviceSnapshot;
  readonly session: BridgeGatewaySession;
}

export interface DeviceRoutingServiceOptions {
  readonly deviceRepository: DeviceRepository;
  readonly credentialRepository: DeviceCredentialRepository;
  readonly deviceSessionRegistry: DeviceSessionRegistry;
}

function notFound(): DeviceRoutingError {
  return new DeviceRoutingError("DEVICE_NOT_FOUND", "Device không tồn tại.");
}

function credentialUnavailable(): DeviceRoutingError {
  return new DeviceRoutingError(
    "DEVICE_CREDENTIAL_UNAVAILABLE",
    "Device credential không khả dụng.",
  );
}

function routingUnavailable(): DeviceRoutingError {
  return new DeviceRoutingError(
    "ROUTING_UNAVAILABLE",
    "Device routing hiện không khả dụng.",
  );
}

function parseOwnerId(ownerId: string): string {
  const result = ownerIdSchema.safeParse(ownerId);
  if (!result.success) throw notFound();
  return result.data;
}

function parseDeviceId(deviceId: string): string {
  const result = deviceIdSchema.safeParse(deviceId);
  if (!result.success) throw notFound();
  return result.data;
}

function sameCredentialGeneration(
  session: {
    readonly credentialGeneration: {
      readonly credentialId: string;
      readonly credentialVersion: number;
    };
  },
  credential: { readonly credentialId: string; readonly version: number },
): boolean {
  return (
    session.credentialGeneration.credentialId === credential.credentialId &&
    session.credentialGeneration.credentialVersion === credential.version
  );
}

function snapshot(
  device: Device,
  status: "online" | "offline",
  connectedAt: Date | null,
  lastSeenAt: Date | null,
): RoutedDeviceSnapshot {
  return Object.freeze({
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    metadata: Object.freeze({ ...device.metadata }),
    createdAt: new Date(device.createdAt.getTime()),
    updatedAt: new Date(device.updatedAt.getTime()),
    status,
    connectedAt: connectedAt ? new Date(connectedAt.getTime()) : null,
    lastSeenAt: lastSeenAt ? new Date(lastSeenAt.getTime()) : null,
  });
}

export class DeviceRoutingService {
  readonly #deviceRepository: DeviceRepository;
  readonly #credentialRepository: DeviceCredentialRepository;
  readonly #deviceSessionRegistry: DeviceSessionRegistry;

  constructor(options: DeviceRoutingServiceOptions) {
    this.#deviceRepository = options.deviceRepository;
    this.#credentialRepository = options.credentialRepository;
    this.#deviceSessionRegistry = options.deviceSessionRegistry;
  }

  async listDevices(ownerId: string): Promise<readonly RoutedDeviceSnapshot[]> {
    const parsedOwnerId = parseOwnerId(ownerId);
    try {
      const devices = await this.#deviceRepository.listByOwnerId(parsedOwnerId);
      const snapshots = await Promise.all(
        devices.map((device) => this.#snapshotDevice(device)),
      );
      return Object.freeze(snapshots);
    } catch (error) {
      throw this.#normalizeError(error);
    }
  }

  async getDevice(
    ownerId: string,
    deviceId: string,
  ): Promise<RoutedDeviceSnapshot> {
    const parsedOwnerId = parseOwnerId(ownerId);
    const parsedDeviceId = parseDeviceId(deviceId);
    try {
      const device = await this.#deviceRepository.getForOwner(
        parsedOwnerId,
        parsedDeviceId,
      );
      if (!device) throw notFound();
      return await this.#snapshotDevice(device);
    } catch (error) {
      throw this.#normalizeError(error);
    }
  }

  async resolve(
    ownerId: string,
    deviceId: string,
  ): Promise<ResolvedDeviceSession> {
    const parsedOwnerId = parseOwnerId(ownerId);
    const parsedDeviceId = parseDeviceId(deviceId);
    try {
      const device = await this.#deviceRepository.getForOwner(
        parsedOwnerId,
        parsedDeviceId,
      );
      if (!device) throw notFound();

      const credential =
        await this.#credentialRepository.getActive(parsedDeviceId);
      if (!credential) throw credentialUnavailable();

      const active = this.#deviceSessionRegistry.getActive(parsedDeviceId);
      if (!active) {
        throw new DeviceRoutingError(
          "DEVICE_OFFLINE",
          "Device hiện không trực tuyến.",
        );
      }
      if (active.ownerId !== parsedOwnerId) throw notFound();
      if (!sameCredentialGeneration(active, credential)) {
        throw credentialUnavailable();
      }

      const current = this.#deviceSessionRegistry.getActive(parsedDeviceId);
      if (
        !current ||
        current.registrationId !== active.registrationId ||
        current.session !== active.session
      ) {
        throw new DeviceRoutingError(
          "DEVICE_OFFLINE",
          "Device session đã thay đổi trong lúc định tuyến.",
        );
      }

      return Object.freeze({
        device: snapshot(
          device,
          "online",
          current.connectedAt,
          current.lastSeenAt,
        ),
        session: current.session,
      });
    } catch (error) {
      throw this.#normalizeError(error);
    }
  }

  async #snapshotDevice(device: Device): Promise<RoutedDeviceSnapshot> {
    const liveness = this.#deviceSessionRegistry.getStatus(device.deviceId);
    const active = this.#deviceSessionRegistry.getActive(device.deviceId);
    if (!active || active.ownerId !== device.ownerId) {
      return snapshot(
        device,
        "offline",
        liveness.connectedAt,
        liveness.lastSeenAt,
      );
    }

    const credential = await this.#credentialRepository.getActive(
      device.deviceId,
    );
    const current = this.#deviceSessionRegistry.getActive(device.deviceId);
    const online =
      credential !== null &&
      sameCredentialGeneration(active, credential) &&
      current?.registrationId === active.registrationId &&
      current.session === active.session &&
      current.ownerId === device.ownerId;

    return snapshot(
      device,
      online ? "online" : "offline",
      online ? current.connectedAt : liveness.connectedAt,
      online ? current.lastSeenAt : liveness.lastSeenAt,
    );
  }

  #normalizeError(error: unknown): DeviceRoutingError {
    return error instanceof DeviceRoutingError ? error : routingUnavailable();
  }
}
