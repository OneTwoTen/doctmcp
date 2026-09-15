import type {
  ClaimPairingInput,
  Device,
  DeviceCredential,
  PairingSession,
} from "@doctmcp/schemas";
import {
  DeviceCredentialError,
  type DeviceCredentialService,
  type IssuedDeviceCredential,
} from "./device-credential";
import type { DeviceRepository } from "./device-repository";
import type { PairingClaimContext, PairingService } from "./pairing";

/**
 * Payload một lần để control-plane giao lại cho đúng local pairing channel.
 * `secret` là raw credential và không được persist/log ở server.
 */
export interface CompletedPairingCredential {
  readonly session: PairingSession;
  readonly device: Device;
  readonly credential: DeviceCredential;
  readonly secret: string;
}

export type PairingCredentialCompletionErrorCode =
  "PAIRING_COMPLETION_UNAVAILABLE";

export class PairingCredentialCompletionError extends Error {
  constructor(
    public readonly code: PairingCredentialCompletionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PairingCredentialCompletionError";
  }
}

export type PairingCredentialCompletionState = "pending" | "delivered";

export interface PairingCredentialCompletionRecord {
  readonly pairingSessionId: string;
  readonly deviceId: string;
  readonly credentialId: string;
  readonly credentialVersion: number;
  readonly state: PairingCredentialCompletionState;
}

export interface PairingCredentialCompletionRepository {
  get(
    pairingSessionId: string,
  ): Promise<PairingCredentialCompletionRecord | null>;
  setPending(input: {
    readonly pairingSessionId: string;
    readonly deviceId: string;
    readonly credentialId: string;
    readonly credentialVersion: number;
  }): Promise<PairingCredentialCompletionRecord | null>;
  acknowledge(input: {
    readonly pairingSessionId: string;
    readonly deviceId: string;
    readonly expectedCredentialId: string;
    readonly expectedCredentialVersion: number;
  }): Promise<PairingCredentialCompletionRecord | null>;
}

function completionSnapshot(
  record: PairingCredentialCompletionRecord,
): PairingCredentialCompletionRecord {
  return Object.freeze({ ...record });
}

/**
 * Reference adapter. Production adapter phải persist state này cùng persistence boundary
 * của pairing/device credential để `delivered` vẫn terminal sau process restart.
 * Repository tuyệt đối không chứa raw credential.
 */
export class InMemoryPairingCredentialCompletionRepository
  implements PairingCredentialCompletionRepository
{
  readonly #records = new Map<string, PairingCredentialCompletionRecord>();
  #tail: Promise<void> = Promise.resolve();

  async get(
    pairingSessionId: string,
  ): Promise<PairingCredentialCompletionRecord | null> {
    const record = this.#records.get(pairingSessionId);
    return record ? completionSnapshot(record) : null;
  }

  async setPending(input: {
    readonly pairingSessionId: string;
    readonly deviceId: string;
    readonly credentialId: string;
    readonly credentialVersion: number;
  }): Promise<PairingCredentialCompletionRecord | null> {
    return this.#exclusive(async () => {
      const existing = this.#records.get(input.pairingSessionId);
      if (existing?.state === "delivered") return null;

      const record = Object.freeze({
        pairingSessionId: input.pairingSessionId,
        deviceId: input.deviceId,
        credentialId: input.credentialId,
        credentialVersion: input.credentialVersion,
        state: "pending" as const,
      });
      this.#records.set(input.pairingSessionId, record);
      return completionSnapshot(record);
    });
  }

  async acknowledge(input: {
    readonly pairingSessionId: string;
    readonly deviceId: string;
    readonly expectedCredentialId: string;
    readonly expectedCredentialVersion: number;
  }): Promise<PairingCredentialCompletionRecord | null> {
    return this.#exclusive(async () => {
      const existing = this.#records.get(input.pairingSessionId);
      if (
        existing?.state !== "pending" ||
        existing.deviceId !== input.deviceId ||
        existing.credentialId !== input.expectedCredentialId ||
        existing.credentialVersion !== input.expectedCredentialVersion
      ) {
        return null;
      }

      const delivered = Object.freeze({
        ...existing,
        state: "delivered" as const,
      });
      this.#records.set(input.pairingSessionId, delivered);
      return completionSnapshot(delivered);
    });
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

export interface PairingCredentialCompletionOptions {
  readonly pairingService: PairingService;
  readonly credentialService: DeviceCredentialService;
  readonly deviceRepository: DeviceRepository;
  readonly completionRepository?: PairingCredentialCompletionRepository;
  /**
   * Runtime hook cho crash recovery khi credential đã persist nhưng raw secret cũ đã mất.
   * Production composition root dùng hook này để rotate qua cùng active-session
   * invalidation boundary như explicit credential rotation.
   */
  readonly recoverExistingCredential?: (
    deviceId: string,
  ) => Promise<IssuedDeviceCredential>;
}

export interface AcknowledgePairingCredentialDeliveryInput {
  readonly pairingSessionId: string;
  readonly ownerId: string;
  readonly credentialId: string;
  readonly credentialVersion: number;
}

export class PairingCredentialCompletionService {
  readonly #pairingService: PairingService;
  readonly #credentialService: DeviceCredentialService;
  readonly #deviceRepository: DeviceRepository;
  readonly #completionRepository: PairingCredentialCompletionRepository;
  readonly #recoverExistingCredential: (
    deviceId: string,
  ) => Promise<IssuedDeviceCredential>;
  readonly #completionBySessionId = new Map<
    string,
    Promise<CompletedPairingCredential>
  >();

  constructor(options: PairingCredentialCompletionOptions) {
    this.#pairingService = options.pairingService;
    this.#credentialService = options.credentialService;
    this.#deviceRepository = options.deviceRepository;
    this.#completionRepository =
      options.completionRepository ??
      new InMemoryPairingCredentialCompletionRepository();
    this.#recoverExistingCredential =
      options.recoverExistingCredential ??
      ((deviceId) => this.#credentialService.rotate(deviceId));
  }

  /**
   * Claim code đúng một lần, sau đó issue credential cho device vừa được claim.
   * Raw secret chỉ được cache transient; durable completion state chỉ lưu generation id.
   */
  async claimAndIssue(
    pairingCode: unknown,
    input: ClaimPairingInput,
    context: PairingClaimContext = {},
  ): Promise<CompletedPairingCredential> {
    const claimed = await this.#pairingService.claimPairingCode(
      pairingCode,
      input,
      context,
    );
    return this.#complete(claimed.session, claimed.device, false);
  }

  /**
   * Recovery path sau khi pairing đã claim nhưng credential issue/delivery chưa hoàn tất.
   * `delivered` là terminal: pairingSessionId cũ không thể mint/rotate credential lại.
   */
  async resumeClaimedPairing(
    pairingSessionId: string,
    ownerId: string,
  ): Promise<CompletedPairingCredential> {
    const session =
      await this.#pairingService.getPairingSession(pairingSessionId);
    if (session?.state !== "claimed" || session.deviceId === undefined) {
      throw completionUnavailable();
    }

    const device = await this.#deviceRepository.getForOwner(
      ownerId,
      session.deviceId,
    );
    if (!device) throw completionUnavailable();

    const persisted = await this.#completionRepository.get(pairingSessionId);
    if (persisted?.state === "delivered") throw completionUnavailable();

    const cached = this.#completionBySessionId.get(pairingSessionId);
    if (cached) return cached;

    return this.#complete(session, device, true);
  }

  /**
   * Chỉ ACK đúng generation đã giao. Owner được resolve server-side trước mutation và
   * repository CAS `pending -> delivered`, vì vậy stale/wrong ACK không xóa pending secret.
   */
  async acknowledgeDelivery(
    input: AcknowledgePairingCredentialDeliveryInput,
  ): Promise<void> {
    const session = await this.#pairingService.getPairingSession(
      input.pairingSessionId,
    );
    if (session?.state !== "claimed" || session.deviceId === undefined) {
      throw completionUnavailable();
    }

    const device = await this.#deviceRepository.getForOwner(
      input.ownerId,
      session.deviceId,
    );
    if (!device) throw completionUnavailable();

    const acknowledged = await this.#completionRepository.acknowledge({
      pairingSessionId: input.pairingSessionId,
      deviceId: device.deviceId,
      expectedCredentialId: input.credentialId,
      expectedCredentialVersion: input.credentialVersion,
    });
    if (!acknowledged) throw completionUnavailable();

    this.#completionBySessionId.delete(input.pairingSessionId);
  }

  async #complete(
    session: PairingSession,
    device: Device,
    recoverExisting: boolean,
  ): Promise<CompletedPairingCredential> {
    const existing = this.#completionBySessionId.get(session.pairingSessionId);
    if (existing) return existing;

    const completion = (async () => {
      const persisted = await this.#completionRepository.get(
        session.pairingSessionId,
      );
      if (persisted?.state === "delivered") throw completionUnavailable();

      let issued: IssuedDeviceCredential;
      try {
        issued = await this.#credentialService.issue(device.deviceId);
      } catch (error) {
        if (
          !recoverExisting ||
          !(error instanceof DeviceCredentialError) ||
          error.code !== "CREDENTIAL_ALREADY_EXISTS"
        ) {
          throw error;
        }
        issued = await this.#recoverExistingCredential(device.deviceId);
      }

      const pending = await this.#completionRepository.setPending({
        pairingSessionId: session.pairingSessionId,
        deviceId: device.deviceId,
        credentialId: issued.credential.credentialId,
        credentialVersion: issued.credential.version,
      });
      if (!pending) throw completionUnavailable();

      return Object.freeze({
        session,
        device,
        credential: issued.credential,
        secret: issued.secret,
      });
    })();

    this.#completionBySessionId.set(session.pairingSessionId, completion);
    try {
      return await completion;
    } catch (error) {
      if (
        this.#completionBySessionId.get(session.pairingSessionId) === completion
      ) {
        this.#completionBySessionId.delete(session.pairingSessionId);
      }
      throw error;
    }
  }
}

export interface PairingCredentialDelivery {
  readonly pairingSessionId: string;
  readonly localCorrelationId?: string;
  readonly deviceId: string;
  readonly credentialId: string;
  readonly credentialVersion: number;
  readonly credential: string;
}

/**
 * Shape dành cho transport/channel delivery: không mang pairing code và không mang owner
 * do local cung cấp. `credential` ở đây là raw secret được giao một lần.
 */
export function toPairingCredentialDelivery(
  completed: CompletedPairingCredential,
): PairingCredentialDelivery {
  return Object.freeze({
    pairingSessionId: completed.session.pairingSessionId,
    ...(completed.session.localCorrelationId !== undefined
      ? { localCorrelationId: completed.session.localCorrelationId }
      : {}),
    deviceId: completed.device.deviceId,
    credentialId: completed.credential.credentialId,
    credentialVersion: completed.credential.version,
    credential: completed.secret,
  });
}

function completionUnavailable(): PairingCredentialCompletionError {
  return new PairingCredentialCompletionError(
    "PAIRING_COMPLETION_UNAVAILABLE",
    "Pairing credential completion không khả dụng.",
  );
}
