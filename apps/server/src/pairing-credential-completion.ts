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

export interface PairingCredentialCompletionOptions {
  readonly pairingService: PairingService;
  readonly credentialService: DeviceCredentialService;
  readonly deviceRepository: DeviceRepository;
  /**
   * Runtime hook cho crash recovery khi credential đã persist nhưng raw secret cũ đã mất.
   * Production composition root dùng hook này để rotate qua cùng active-session
   * invalidation boundary như explicit credential rotation.
   */
  readonly recoverExistingCredential?: (
    deviceId: string,
  ) => Promise<IssuedDeviceCredential>;
}

export class PairingCredentialCompletionService {
  readonly #pairingService: PairingService;
  readonly #credentialService: DeviceCredentialService;
  readonly #deviceRepository: DeviceRepository;
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
    this.#recoverExistingCredential =
      options.recoverExistingCredential ?? ((deviceId) => this.#credentialService.rotate(deviceId));
  }

  /**
   * Claim code đúng một lần, sau đó issue credential cho device vừa được claim.
   * Completion thành công được giữ tạm trong memory theo pairingSessionId cho tới khi
   * delivery được acknowledge. Việc này cho phép retry cùng process trả lại đúng raw
   * credential thay vì issue thêm generation mới.
   *
   * Nếu credential issue fail sau khi pairing đã claim, caller có thể gọi
   * resumeClaimedPairing() bằng pairingSessionId đã biết từ local pairing channel.
   *
   * Nếu process restart sau khi credential digest đã persist nhưng trước delivery/ack,
   * resume sẽ phát hiện credential active đã tồn tại, rotate generation đó và trả raw
   * secret mới. Secret cũ trở thành vô hiệu nên server không cần persist raw credential.
   *
   * Production persistence dùng chung database vẫn nên đặt pairing + device + credential
   * persistence trong cùng transaction/unit-of-work để giảm recovery path cần thiết.
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
   * Ownership luôn được resolve lại từ server-side DeviceRepository, kể cả khi completion
   * đang có trong transient cache; pairingSessionId một mình không phải authorization.
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

    const cached = this.#completionBySessionId.get(pairingSessionId);
    if (cached) return cached;

    return this.#complete(session, device, true);
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
    recoverExisting: boolean,
  ): Promise<CompletedPairingCredential> {
    const existing = this.#completionBySessionId.get(session.pairingSessionId);
    if (existing) return existing;

    const completion = (async () => {
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
