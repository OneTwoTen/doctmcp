import type { DeviceSessionCredentialGeneration } from "./device-session-registry";

export const DEFAULT_CREDENTIAL_INVALIDATION_BOUND_MS = 5_000;

export type DeviceCredentialInvalidationKind = "revoked" | "rotated";

export interface DeviceCredentialInvalidationEvent
  extends DeviceSessionCredentialGeneration {
  readonly eventId: string;
  readonly kind: DeviceCredentialInvalidationKind;
  readonly deviceId: string;
  readonly publishedAt: string;
}

export type DeviceCredentialInvalidationHandler = (
  event: DeviceCredentialInvalidationEvent,
) => void | Promise<void>;

export interface DeviceCredentialInvalidationBus {
  publish(event: DeviceCredentialInvalidationEvent): Promise<void>;
  subscribe(handler: DeviceCredentialInvalidationHandler): () => void;
}

export interface CreateDeviceCredentialInvalidationEventInput
  extends DeviceSessionCredentialGeneration {
  readonly kind: DeviceCredentialInvalidationKind;
  readonly deviceId: string;
  readonly eventId?: string;
  readonly publishedAt?: Date;
}

export function createDeviceCredentialInvalidationEvent(
  input: CreateDeviceCredentialInvalidationEventInput,
): DeviceCredentialInvalidationEvent {
  if (!input.deviceId || !input.credentialId) {
    throw new Error("Credential invalidation metadata không hợp lệ.");
  }
  if (
    !Number.isInteger(input.credentialVersion) ||
    input.credentialVersion <= 0
  ) {
    throw new Error("Credential invalidation version không hợp lệ.");
  }
  const publishedAt = input.publishedAt ?? new Date();
  if (!Number.isFinite(publishedAt.getTime())) {
    throw new Error("Credential invalidation timestamp không hợp lệ.");
  }

  return Object.freeze({
    eventId: input.eventId ?? globalThis.crypto.randomUUID(),
    kind: input.kind,
    deviceId: input.deviceId,
    credentialId: input.credentialId,
    credentialVersion: input.credentialVersion,
    publishedAt: publishedAt.toISOString(),
  });
}

/**
 * Reference implementation cho test/single-process composition.
 * Production nhiều server instance phải inject adapter dùng shared pub/sub.
 */
export class InMemoryDeviceCredentialInvalidationBus
  implements DeviceCredentialInvalidationBus
{
  readonly #handlers = new Set<DeviceCredentialInvalidationHandler>();

  subscribe(handler: DeviceCredentialInvalidationHandler): () => void {
    this.#handlers.add(handler);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#handlers.delete(handler);
    };
  }

  async publish(event: DeviceCredentialInvalidationEvent): Promise<void> {
    const snapshot = createDeviceCredentialInvalidationEvent({
      eventId: event.eventId,
      kind: event.kind,
      deviceId: event.deviceId,
      credentialId: event.credentialId,
      credentialVersion: event.credentialVersion,
      publishedAt: new Date(event.publishedAt),
    });
    const results = await Promise.allSettled(
      [...this.#handlers].map((handler) => Promise.resolve(handler(snapshot))),
    );
    if (results.some((result) => result.status === "rejected")) {
      throw new Error("Credential invalidation subscriber xử lý thất bại.");
    }
  }
}
