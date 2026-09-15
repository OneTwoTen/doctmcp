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
import type {
  PairingClaimContext,
  PairingService,
} from "./pairing";

/**
 * Payload một lần để control-plane giao lại cho đúng local pairing channel.
 * `credential` là raw secret và không được persist/log ở server.
 */
export interface CompletedPairingCredential {
  readonly pairingSessionId: string;
  readonly localCorrelationId?: string;
  readonly device: Device;
  readonly credential: DeviceCredential;
  readonly secret: string;
}

export interface PairingCredentialCompletionOptions {
  readonly pairingService: PairingService;
  readonly credentialService: DeviceCredentialService;
}

export class PairingCredentialCompletionService {
  readonly #pairingService: PairingService;
  readonly #credentialService: DeviceCredentialService;

  constructor(options: PairingCredentialCompletionOptions) {
    this.#pairingService = options.pairingService;
    this.#credentialService = options.credentialService;
  }

  /**
   * Claim là one-time boundary có trước. Chỉ claim thành công mới được issue credential.
   * Vì pairing code bị consume sau claim, duplicate/replay không thể chạy đến issue lần hai.
   *
   * Production persistence nên đặt pairing + device + credential trong cùng transaction
   * khi các repository dùng chung database. Reference in-memory adapter giữ contract
   * one-time nhưng không giả vờ cung cấp distributed transaction giữa hai repository.
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
    const issued: IssuedDeviceCredential =
      await this.#credentialService.issue(claimed.device.deviceId);

    return Object.freeze({
      pairingSessionId: claimed.session.pairingSessionId,
      ...(claimed.session.localCorrelationId !== undefined
        ? { localCorrelationId: claimed.session.localCorrelationId }
        : {}),
      device: claimed.device,
      credential: issued.credential,
      secret: issued.secret,
    });
  }
}

export interface PairingCredentialDelivery {
  readonly pairingSession: PairingSession;
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
  const pairingSession: PairingSession = Object.freeze({
    pairingSessionId: completed.pairingSessionId,
    state: "claimed",
    createdAt: completed.device.createdAt,
    expiresAt: completed.device.createdAt,
    claimedAt: completed.device.createdAt,
    deviceId: completed.device.deviceId,
    ...(completed.localCorrelationId !== undefined
      ? { localCorrelationId: completed.localCorrelationId }
      : {}),
  });

  return Object.freeze({
    pairingSession,
    deviceId: completed.device.deviceId,
    credentialId: completed.credential.credentialId,
    credentialVersion: completed.credential.version,
    credential: completed.secret,
  });
}
