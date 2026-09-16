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
}

interface CompletionGenerationInput {
  readonly pairingSessionId: string;
  readonly deviceId: string;
  readonly credentialId: string;
  readonly credentialVersion: number;
}

export interface PairingCredentialCompletionRepository {
  get(
    pairingSessionId: string,
  ): Promise<PairingCredentialCompletionRecord | null>;
  setPending(
    input: CompletionGenerationInput,
  ): Promise<PairingCredentialCompletionRecord | null>;
  beginRecovery(
    input: CompletionGenerationInput,
  ): Promise<PairingCredentialCompletionRecord | null>;
  advanceRecovery(input: {
    readonly pairingSessionId: string;
    readonly deviceId: string;
    readonly expectedCredentialId: string;
    readonly expectedCredentialVersion: number;
    readonly credentialId: string;
    readonly credentialVersion: number;
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

  async setPending(
    input: CompletionGenerationInput,
  ): Promise<PairingCredentialCompletionRecord | null> {
    return this.#exclusive(async () => {
      const existing = this.#records.get(input.pairingSessionId);
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

      const record = Object.freeze({
        ...input,
        state: "pending" as const,
      });
      this.#records.set(input.pairingSessionId, record);
      return completionSnapshot(record);
    });
  }

  async beginRecovery(
    input: CompletionGenerationInput,
  ): Promise<PairingCredentialCompletionRecord | null> {
    return this.#exclusive(async () => {
      const existing = this.#records.get(input.pairingSessionId);
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

      const source = existing?.state === "pending" ? existing : input;
      const recovering = Object.freeze({
        pairingSessionId: input.pairingSessionId,
        deviceId: input.deviceId,
        credentialId: source.credentialId,
        credentialVersion: source.credentialVersion,
        state: "recovering" as const,
      });
      this.#records.set(input.pairingSessionId, recovering);
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
  }): Promise<PairingCredentialCompletionRecord | null> {
    return this.#exclusive(async () => {
      const existing = this.#records.get(input.pairingSessionId);
      if (
        existing?.state !== "recovering" ||
        existing.deviceId !== input.deviceId ||
        !sameGeneration(
          existing,
          input.expectedCredentialId,
          input.expectedCredentialVersion,
        )
      ) {
        return null;
      }

      const advanced = Object.freeze({
        pairingSessionId: input.pairingSessionId,
        deviceId: input.deviceId,
        credentialId: input.credentialId,
        credentialVersion: input.credentialVersion,
        state: "recovering" as const,
      });
      this.#records.set(input.pairingSessionId, advanced);
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
      const existing = this.#records.get(input.pairingSessionId);
      if (
        existing?.state !== "recovering" ||
        existing.deviceId !== input.deviceId ||
        !sameGeneration(
          existing,
          input.expectedCredentialId,
          input.expectedCredentialVersion,
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
      this.#records.set(input.pairingSessionId, pending);
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
      const existing = this.#records.get(input.pairingSessionId);
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
  readonly recoverExistingCredential?: (
    deviceId: string,
    expectedCredentialId: string,
    expectedCredentialVersion: number,
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
      ((deviceId, expectedCredentialId, expectedCredentialVersion) =>
        this.#credentialService.rotateExpected(
          deviceId,
          expectedCredentialId,
          expectedCredentialVersion,
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

    const reserved = await this.#completionRepository.beginRecovery({
      pairingSessionId: session.pairingSessionId,
      deviceId: device.deviceId,
      credentialId: sourceCredentialId,
      credentialVersion: sourceCredentialVersion,
    });
    if (reserved?.state !== "recovering") {
      throw completionUnavailable();
    }

    for (let step = 0; step < MAX_RECOVERY_STEPS; step += 1) {
      const recovery = await this.#completionRepository.get(
        session.pairingSessionId,
      );
      if (recovery?.state !== "recovering") {
        throw completionUnavailable();
      }

      const active = await this.#getActiveOrNull(device.deviceId);
      if (!active) {
        let issued: IssuedDeviceCredential;
        try {
          issued = await this.#credentialService.issue(device.deviceId);
        } catch (error) {
          if (
            error instanceof DeviceCredentialError &&
            error.code === "CREDENTIAL_ALREADY_EXISTS"
          ) {
            continue;
          }
          throw error;
        }
        const finalized = await this.#finishRecovery(recovery, issued);
        if (finalized) return issued;
        continue;
      }

      if (
        active.credentialId !== recovery.credentialId ||
        active.version !== recovery.credentialVersion
      ) {
        await this.#completionRepository.advanceRecovery({
          pairingSessionId: session.pairingSessionId,
          deviceId: device.deviceId,
          expectedCredentialId: recovery.credentialId,
          expectedCredentialVersion: recovery.credentialVersion,
          credentialId: active.credentialId,
          credentialVersion: active.version,
        });
        continue;
      }

      let issued: IssuedDeviceCredential;
      try {
        issued = await this.#recoverExistingCredential(
          device.deviceId,
          recovery.credentialId,
          recovery.credentialVersion,
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

      const finalized = await this.#finishRecovery(recovery, issued);
      if (finalized) return issued;
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
