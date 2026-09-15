import type {
  ClaimPairingInput,
  Device,
  DeviceCredential,
  PairingSession,
} from "@doctmcp/schemas";
import type {
  DeviceCredentialService,
  IssuedDeviceCredential,
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

export interface PairingCredentialCompletionOptions {
  readonly pairingService: PairingService;
  readonly credentialService: DeviceCredentialService;
  readonly deviceRepository: DeviceRepository;
}

export class PairingCredentialCompletionService {
  readonly #pairingService: PairingService;
  readonly #credentialService: DeviceCredentialService;
  readonly #deviceRepository: DeviceRepository;
  readonly #completionBySessionId = new Map<
    string,
    Promise<CompletedPairingCredential>
  >();

  constructor(options: PairingCredentialCompletionOptions) {
    this.#pairingService = options.pairingService;
    this.#credentialService = options.credentialService;
    this.#deviceRepository = options.deviceRepository;
  }

  /**
   * Claim code đúng một lần, sau đó issue credential cho device vừa được claim.
   * Completion thành công được giữ tạm trong memory theo pairingSessionId cho tới khi
   * delivery được acknowledge. Việc này cho phép retry cùng process trả lại đúng raw
   * credential thay vì issue thêm generation mới.
   *
   * Nếu credential issue fail sau khi pairing đã claim, caller có thể gọi
   * resumeClaimedPairing() bằng pairingSessionId đã biết từ local pairing channel.
   * Reference runtime vì vậy recoverable dù hai repository tách rời.
   *
   * Production persistence dùng chung database vẫn nên đặt pairing + device + credential
   * persistence trong cùng transaction/unit-of-work. Raw credential pending delivery chỉ
   * được giữ transient trong memory, không được persist hoặc log.
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
    return this.#complete(claimed.session, claimed.device);
  }

  /**
   * Recovery path sau khi pairing đã claim nhưng credential issue/delivery chưa hoàn tất.
   * Ownership luôn được resolve lại từ server-side DeviceRepository.
   */
  async resumeClaimedPairing(
    pairingSessionId: string,
    ownerId: string,
  ): Promise<CompletedPairingCredential> {
    const cached = this.#completionBySessionId.get(pairingSessionId);
    if (cached) return cached;

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

    return this.#complete(session, device);
  }

  /**
   * Gọi sau khi local đã persist credential thành công để xóa raw secret khỏi memory.
   */
  acknowledgeDelivery(pairingSessionId: string): void {
    this.#completionBySessionId.delete(pairingSessionId);
  }

  async #complete(
    session: PairingSession,
    device: Device,
  ): Promise<CompletedPairingCredential> {
    const existing = this.#completionBySessionId.get(session.pairingSessionId);
    if (existing) return existing;

    const completion = (async () => {
      const issued: IssuedDeviceCredential =
        await this.#credentialService.issue(device.deviceId);
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
