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

export type PairingCredentialCompletionState =
  | "pending"
  | "recovering"
  | "delivered";

export interface PairingCredentialCompletionRecord {
  readonly pairingSessionId: string;
  readonly deviceId: string;
  readonly credentialId: string;
  readonly credentialVersion: number;
  readonly state: PairingCredentialCompletionState;
  /**
   * Chỉ có ở state `recovering`. Target được persist trước rotate để lần resume
   * phân biệt credential do recovery tạo với revoke/rotate bên ngoài pairing.
   */
  readonly recoveryTargetCredentialId?: string;
}

interface CompletionGenerationInput {
  readonly pairingSessionId: string;
  readonly deviceId: string;
  readonly credentialId: string;
  readonly credentialVersion: number;
}

interface BeginRecoveryInput extends CompletionGenerationInput {
  readonly recoveryTargetCredentialId: string;
}

export interface PairingCredentialCompletionRepository {
  reserve(pairingSessionId: string): Promise<boolean>;
  get(
    pairingSessionId: string,
  ): Promise<PairingCredentialCompletionRecord | null>;
  setPending(
    input: CompletionGenerationInput,
  ): Promise<PairingCredentialCompletionRecord | null>;
  beginRecovery(
    input: BeginRecoveryInput,
  ): Promise<PairingCredentialCompletionRecord | null>;
  advanceRecovery(input: {
    readonly pairingSessionId: string;
    readonly deviceId: string;
    readonly expectedCredentialId: string;
    readonly expectedCredentialVersion: number;
    readonly credentialId: string;
    readonly credentialVersion: number;
    readonly recoveryTargetCredentialId: string;
  }): Promise<PairingCredentialCompletionRecord | null>;
  finishRecovery(input: {
    readonly pairingSessionId: string;
    readonly deviceId: string;
    readonly expectedCredentialId: string;
    readonly expectedCredentialVersion: number;
    readonly credentialId: string;
    readonly credentialVersion: number;
  }): Promise<PairingCredentialCompletionRecord | null>;
  acknowledge(input: {
    readonly pairingSessionId: string;
    readonly deviceId: string;
    readonly expectedCredentialId: string;
    readonly expectedCredentialVersion: number;
  }): Promise<PairingCredentialCompletionRecord | null>;
  delete(pairingSessionId: string): Promise<void>;
}

function completionSnapshot(
  record: PairingCredentialCompletionRecord,
): PairingCredentialCompletionRecord {
  return Object.freeze({ ...record });
}

function sameGeneration(
  record: PairingCredentialCompletionRecord,
  credentialId: string,
  credentialVersion: number,
): boolean {
  return (
    record.credentialId === credentialId &&
    record.credentialVersion === credentialVersion
  );
}

function isReservedRecoveryTarget(
  record: PairingCredentialCompletionRecord,
  credentialId: string,
  credentialVersion: number,
): boolean {
  return (
    record.state === "recovering" &&
    record.recoveryTargetCredentialId === credentialId &&
    credentialVersion === record.credentialVersion + 1
  );
}

export const DEFAULT_PAIRING_COMPLETION_MAX_RECORDS = 1_024;
export const DEFAULT_PAIRING_COMPLETION_RETENTION_MS = 5 * 60_000;

export interface InMemoryPairingCredentialCompletionRepositoryOptions {
  readonly now?: () => Date;
  readonly maxRecords?: number;
  readonly retentionMs?: number;
}

interface StoredPairingCredentialCompletionRecord {
  readonly record: PairingCredentialCompletionRecord;
  readonly expiresAtMs: number;
}

export class InMemoryPairingCredentialCompletionRepository
  implements PairingCredentialCompletionRepository
{
  readonly #records = new Map<
    string,
    StoredPairingCredentialCompletionRecord
  >();
  readonly #reservations = new Map<string, number>();
  readonly #now: () => Date;
  readonly #maxRecords: number;
  readonly #retentionMs: number;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    options: InMemoryPairingCredentialCompletionRepositoryOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#maxRecords =
      options.maxRecords ?? DEFAULT_PAIRING_COMPLETION_MAX_RECORDS;
    this.#retentionMs =
      options.retentionMs ?? DEFAULT_PAIRING_COMPLETION_RETENTION_MS;
    if (
      !Number.isSafeInteger(this.#maxRecords) ||
      this.#maxRecords <= 0 ||
      !Number.isSafeInteger(this.#retentionMs) ||
      this.#retentionMs <= 0
    ) {
      throw new Error(
        "Pairing completion repository limits must be positive safe integers.",
      );
    }
  }

  get size(): number {
    this.#pruneExpired();
    return this.#records.size + this.#reservations.size;
  }

  async reserve(pairingSessionId: string): Promise<boolean> {
    return this.#exclusive(async () => {
      this.#pruneExpired();
      if (
        this.#records.has(pairingSessionId) ||
        this.#reservations.has(pairingSessionId)
      ) {
        return true;
      }
      if (this.#records.size + this.#reservations.size >= this.#maxRecords) {
        return false;
      }
      this.#reservations.set(
        pairingSessionId,
        this.#nowMs() + this.#retentionMs,
      );
      return true;
    });
  }

  async get(
    pairingSessionId: string,
  ): Promise<PairingCredentialCompletionRecord | null> {
    this.#pruneExpired();
    const stored = this.#records.get(pairingSessionId);
    return stored ? completionSnapshot(stored.record) : null;
  }

  async setPending(
    input: CompletionGenerationInput,
  ): Promise<PairingCredentialCompletionRecord | null> {
    return this.#exclusive(async () => {
      this.#pruneExpired();
      const existing = this.#records.get(input.pairingSessionId)?.record;
      if (existing) {
        if (
          existing.state === "pending" &&
          existing.deviceId === input.deviceId &&
          sameGeneration(existing, input.credentialId, input.credentialVersion)
        ) {
          return completionSnapshot(existing);
        }
        return null;
      }
      if (
        !this.#reservations.has(input.pairingSessionId) &&
        this.#records.size + this.#reservations.size >= this.#maxRecords
      ) {
        return null;
      }

      const record = Object.freeze({
        ...input,
        state: "pending" as const,
      });
      this.#store(record);
      return completionSnapshot(record);
    });
  }

  async beginRecovery(
    input: BeginRecoveryInput,
  ): Promise<PairingCredentialCompletionRecord | null> {
    return this.#exclusive(async () => {
      this.#pruneExpired();
      const existing = this.#records.get(input.pairingSessionId)?.record;
      if (existing?.state === "delivered") return null;
      if (
        existing?.deviceId !== undefined &&
        existing.deviceId !== input.deviceId
      ) {
        return null;
      }
      if (existing?.state === "recovering") {
        return completionSnapshot(existing);
      }
      if (
        !existing &&
        !this.#reservations.has(input.pairingSessionId) &&
        this.#records.size + this.#reservations.size >= this.#maxRecords
      ) {
        return null;
      }

      const source = existing?.state === "pending" ? existing : input;
      const recovering = Object.freeze({
        pairingSessionId: input.pairingSessionId,
        deviceId: input.deviceId,
        credentialId: source.credentialId,
        credentialVersion: source.credentialVersion,
        recoveryTargetCredentialId: input.recoveryTargetCredentialId,
        state: "recovering" as const,
      });
      this.#store(recovering);
      return completionSnapshot(recovering);
    });
  }

  async advanceRecovery(input: {
    readonly pairingSessionId: string;
    readonly deviceId: string;
    readonly expectedCredentialId: string;
    readonly expectedCredentialVersion: number;
    readonly credentialId: string;
    readonly credentialVersion: number;
    readonly recoveryTargetCredentialId: string;
  }): Promise<PairingCredentialCompletionRecord | null> {
    return this.#exclusive(async () => {
      this.#pruneExpired();
      const existing = this.#records.get(input.pairingSessionId)?.record;
      if (
        existing?.state !== "recovering" ||
        existing.deviceId !== input.deviceId ||
        !sameGeneration(
          existing,
          input.expectedCredentialId,
          input.expectedCredentialVersion,
        ) ||
        !isReservedRecoveryTarget(
          existing,
          input.credentialId,
          input.credentialVersion,
        )
      ) {
        return null;
      }

      const advanced = Object.freeze({
        pairingSessionId: input.pairingSessionId,
        deviceId: input.deviceId,
        credentialId: input.credentialId,
        credentialVersion: input.credentialVersion,
        recoveryTargetCredentialId: input.recoveryTargetCredentialId,
        state: "recovering" as const,
      });
      this.#store(advanced);
      return completionSnapshot(advanced);
    });
  }

  async finishRecovery(input: {
    readonly pairingSessionId: string;
    readonly deviceId: string;
    readonly expectedCredentialId: string;
    readonly expectedCredentialVersion: number;
    readonly credentialId: string;
    readonly credentialVersion: number;
  }): Promise<PairingCredentialCompletionRecord | null> {
    return this.#exclusive(async () => {
      this.#pruneExpired();
      const existing = this.#records.get(input.pairingSessionId)?.record;
      if (
        existing?.state !== "recovering" ||
        existing.deviceId !== input.deviceId ||
        !sameGeneration(
          existing,
          input.expectedCredentialId,
          input.expectedCredentialVersion,
        ) ||
        !isReservedRecoveryTarget(
          existing,
          input.credentialId,
          input.credentialVersion,
        )
      ) {
        return null;
      }

      const pending = Object.freeze({
        pairingSessionId: input.pairingSessionId,
        deviceId: input.deviceId,
        credentialId: input.credentialId,
        credentialVersion: input.credentialVersion,
        state: "pending" as const,
      });
      this.#store(pending);
      return completionSnapshot(pending);
    });
  }

  async acknowledge(input: {
    readonly pairingSessionId: string;
    readonly deviceId: string;
    readonly expectedCredentialId: string;
    readonly expectedCredentialVersion: number;
  }): Promise<PairingCredentialCompletionRecord | null> {
    return this.#exclusive(async () => {
      this.#pruneExpired();
      const existing = this.#records.get(input.pairingSessionId)?.record;
      if (
        !existing ||
        existing.deviceId !== input.deviceId ||
        !sameGeneration(
          existing,
          input.expectedCredentialId,
          input.expectedCredentialVersion,
        )
      ) {
        return null;
      }

      if (existing.state === "delivered") {
        return completionSnapshot(existing);
      }
      if (existing.state !== "pending") return null;

      const delivered = Object.freeze({
        ...existing,
        state: "delivered" as const,
      });
      this.#store(delivered);
      return completionSnapshot(delivered);
    });
  }

  async delete(pairingSessionId: string): Promise<void> {
    await this.#exclusive(async () => {
      this.#records.delete(pairingSessionId);
      this.#reservations.delete(pairingSessionId);
    });
  }

  #store(record: PairingCredentialCompletionRecord): void {
    this.#reservations.delete(record.pairingSessionId);
    this.#records.set(record.pairingSessionId, {
      record,
      expiresAtMs: this.#nowMs() + this.#retentionMs,
    });
  }

  #pruneExpired(): void {
    const now = this.#nowMs();
    for (const [pairingSessionId, stored] of this.#records) {
      if (stored.expiresAtMs <= now) this.#records.delete(pairingSessionId);
    }
    for (const [pairingSessionId, expiresAtMs] of this.#reservations) {
      if (expiresAtMs <= now) this.#reservations.delete(pairingSessionId);
    }
  }

  #nowMs(): number {
    const now = this.#now().getTime();
    if (!Number.isFinite(now)) {
      throw new Error("Pairing completion repository clock is invalid.");
    }
    return now;
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
  readonly recoverExistingCredential?: (
    deviceId: string,
    expectedCredentialId: string,
    expectedCredentialVersion: number,
    credentialId: string,
  ) => Promise<IssuedDeviceCredential>;
}

export interface AcknowledgePairingCredentialDeliveryInput {
  readonly pairingSessionId: string;
  readonly ownerId: string;
  readonly credentialId: string;
  readonly credentialVersion: number;
}

const MAX_RECOVERY_STEPS = 16;

export class PairingCredentialCompletionService {
  readonly #pairingService: PairingService;
  readonly #credentialService: DeviceCredentialService;
  readonly #deviceRepository: DeviceRepository;
  readonly #completionRepository: PairingCredentialCompletionRepository;
  readonly #recoverExistingCredential: (
    deviceId: string,
    expectedCredentialId: string,
    expectedCredentialVersion: number,
    credentialId: string,
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
      ((
        deviceId,
        expectedCredentialId,
        expectedCredentialVersion,
        credentialId,
      ) =>
        this.#credentialService.rotateExpectedWithCredentialId(
          deviceId,
          expectedCredentialId,
          expectedCredentialVersion,
          credentialId,
        ));
  }

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

  async forgetPendingCompletion(
    pairingSessionId: string,
    preserveDelivered = false,
  ): Promise<void> {
    this.#completionBySessionId.delete(pairingSessionId);
    if (!preserveDelivered) {
      await this.#completionRepository.delete(pairingSessionId);
    }
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

      if (recoverExisting && persisted) {
        const issued = await this.#recover(session, device, persisted);
        return completedSnapshot(session, device, issued);
      }

      const admitted = await this.#completionRepository.reserve(
        session.pairingSessionId,
      );
      if (!admitted) throw completionUnavailable();

      let issued: IssuedDeviceCredential;
      try {
        issued = await this.#credentialService.issue(device.deviceId);
      } catch (error) {
        if (
          !recoverExisting ||
          !(error instanceof DeviceCredentialError) ||
          error.code !== "CREDENTIAL_ALREADY_EXISTS"
        ) {
          await this.#completionRepository
            .delete(session.pairingSessionId)
            .catch(() => undefined);
          throw error;
        }
        const recovered = await this.#recover(session, device, null);
        return completedSnapshot(session, device, recovered);
      }

      const pending = await this.#completionRepository.setPending({
        pairingSessionId: session.pairingSessionId,
        deviceId: device.deviceId,
        credentialId: issued.credential.credentialId,
        credentialVersion: issued.credential.version,
      });
      if (!pending) throw completionUnavailable();

      return completedSnapshot(session, device, issued);
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

  async #recover(
    session: PairingSession,
    device: Device,
    persisted: PairingCredentialCompletionRecord | null,
  ): Promise<IssuedDeviceCredential> {
    let sourceCredentialId: string;
    let sourceCredentialVersion: number;
    if (persisted) {
      sourceCredentialId = persisted.credentialId;
      sourceCredentialVersion = persisted.credentialVersion;
    } else {
      const active = await this.#getActiveOrNull(device.deviceId);
      if (!active) throw completionUnavailable();
      sourceCredentialId = active.credentialId;
      sourceCredentialVersion = active.version;
    }

    const reserved =
      persisted?.state === "recovering"
        ? persisted
        : await this.#completionRepository.beginRecovery({
            pairingSessionId: session.pairingSessionId,
            deviceId: device.deviceId,
            credentialId: sourceCredentialId,
            credentialVersion: sourceCredentialVersion,
            recoveryTargetCredentialId:
              this.#credentialService.createCredentialId(),
          });
    if (
      reserved?.state !== "recovering" ||
      !reserved.recoveryTargetCredentialId
    ) {
      throw completionUnavailable();
    }

    for (let step = 0; step < MAX_RECOVERY_STEPS; step += 1) {
      const recovery = await this.#completionRepository.get(
        session.pairingSessionId,
      );
      if (
        recovery?.state !== "recovering" ||
        !recovery.recoveryTargetCredentialId
      ) {
        throw completionUnavailable();
      }

      const active = await this.#getActiveOrNull(device.deviceId);
      if (!active) {
        // Recovery không bao giờ chủ động revoke. Active biến mất nghĩa là một
        // lifecycle mutation bên ngoài đã thắng; tuyệt đối không issue lại.
        throw completionUnavailable();
      }

      if (
        active.credentialId !== recovery.credentialId ||
        active.version !== recovery.credentialVersion
      ) {
        // Chỉ generation đúng target đã reserve trước rotate mới được coi là
        // commit của recovery bị crash. Generation khác thuộc mutation ngoài.
        if (
          !isReservedRecoveryTarget(
            recovery,
            active.credentialId,
            active.version,
          )
        ) {
          throw completionUnavailable();
        }

        const advanced = await this.#completionRepository.advanceRecovery({
          pairingSessionId: session.pairingSessionId,
          deviceId: device.deviceId,
          expectedCredentialId: recovery.credentialId,
          expectedCredentialVersion: recovery.credentialVersion,
          credentialId: active.credentialId,
          credentialVersion: active.version,
          recoveryTargetCredentialId:
            this.#credentialService.createCredentialId(),
        });
        if (!advanced) continue;
        continue;
      }

      let issued: IssuedDeviceCredential;
      try {
        issued = await this.#recoverExistingCredential(
          device.deviceId,
          recovery.credentialId,
          recovery.credentialVersion,
          recovery.recoveryTargetCredentialId,
        );
      } catch (error) {
        if (
          error instanceof DeviceCredentialError &&
          error.code === "CREDENTIAL_UNAVAILABLE"
        ) {
          continue;
        }
        throw error;
      }

      if (
        !isReservedRecoveryTarget(
          recovery,
          issued.credential.credentialId,
          issued.credential.version,
        )
      ) {
        throw completionUnavailable();
      }

      const finalized = await this.#finishRecovery(recovery, issued);
      if (finalized) {
        // Linearization check: nếu revoke/rotate bên ngoài chen vào sau recovery
        // rotate nhưng trước completion finalize, tuyệt đối không trả raw secret
        // của generation đã mất hiệu lực cho local.
        const activeAfterFinalize = await this.#getActiveOrNull(
          device.deviceId,
        );
        if (
          !activeAfterFinalize ||
          activeAfterFinalize.credentialId !== issued.credential.credentialId ||
          activeAfterFinalize.version !== issued.credential.version
        ) {
          throw completionUnavailable();
        }
        return issued;
      }
    }

    throw completionUnavailable();
  }

  async #finishRecovery(
    recovery: PairingCredentialCompletionRecord,
    issued: IssuedDeviceCredential,
  ): Promise<boolean> {
    const pending = await this.#completionRepository.finishRecovery({
      pairingSessionId: recovery.pairingSessionId,
      deviceId: recovery.deviceId,
      expectedCredentialId: recovery.credentialId,
      expectedCredentialVersion: recovery.credentialVersion,
      credentialId: issued.credential.credentialId,
      credentialVersion: issued.credential.version,
    });
    return pending?.state === "pending";
  }

  async #getActiveOrNull(deviceId: string): Promise<DeviceCredential | null> {
    try {
      return await this.#credentialService.getActive(deviceId);
    } catch (error) {
      if (
        error instanceof DeviceCredentialError &&
        error.code === "CREDENTIAL_UNAVAILABLE"
      ) {
        return null;
      }
      throw error;
    }
  }
}

function completedSnapshot(
  session: PairingSession,
  device: Device,
  issued: IssuedDeviceCredential,
): CompletedPairingCredential {
  return Object.freeze({
    session,
    device,
    credential: issued.credential,
    secret: issued.secret,
  });
}

export interface PairingCredentialDelivery {
  readonly pairingSessionId: string;
  readonly localCorrelationId?: string;
  readonly deviceId: string;
  readonly credentialId: string;
  readonly credentialVersion: number;
  readonly credential: string;
}

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
