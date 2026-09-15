import type { DeviceCredential } from "@doctmcp/schemas";
import {
  DeviceCredentialService,
  InMemoryDeviceCredentialRepository,
  type IssuedDeviceCredential,
} from "./device-credential";
import { InMemoryDeviceRepository } from "./device-repository";
import {
  type BridgeGateway,
  type BridgeGatewaySession,
  type CreateBridgeGatewayOptions,
  createBridgeGateway,
} from "./gateway";
import {
  InMemoryPairingSessionRepository,
  PairingService,
} from "./pairing";
import { PairingCredentialCompletionService } from "./pairing-credential-completion";

export interface CreateDoctmcpServerRuntimeOptions
  extends Omit<
    CreateBridgeGatewayOptions,
    "authenticateDevice" | "allowLegacyUnauthenticated" | "onSession"
  > {
  readonly onSession?: (session: BridgeGatewaySession) => void;
}

export interface DoctmcpServerRuntime {
  readonly gateway: BridgeGateway;
  readonly deviceRepository: InMemoryDeviceRepository;
  readonly credentialRepository: InMemoryDeviceCredentialRepository;
  readonly credentialService: DeviceCredentialService;
  readonly pairingService: PairingService;
  readonly pairingCredentialCompletionService: PairingCredentialCompletionService;
  revokeDeviceCredential(deviceId: string): Promise<DeviceCredential>;
  rotateDeviceCredential(deviceId: string): Promise<IssuedDeviceCredential>;
  stop(): Promise<void>;
}

/**
 * Reference server composition root cho M3.
 *
 * Gateway production path luôn được wire với DeviceCredentialService.verify(); legacy
 * unauthenticated mode không được expose từ composition root này. In-memory repositories
 * là reference adapters cho tới khi persistence adapter production được thêm ở milestone
 * sau; mọi service trong runtime dùng chung đúng repository instances.
 */
export function createDoctmcpServerRuntime(
  options: CreateDoctmcpServerRuntimeOptions = {},
): DoctmcpServerRuntime {
  const deviceRepository = new InMemoryDeviceRepository();
  const credentialRepository = new InMemoryDeviceCredentialRepository();
  const credentialService = new DeviceCredentialService({
    repository: credentialRepository,
    deviceRepository,
  });
  const pairingRepository = new InMemoryPairingSessionRepository(deviceRepository);
  const pairingService = new PairingService({ repository: pairingRepository });
  const pairingCredentialCompletionService =
    new PairingCredentialCompletionService({
      pairingService,
      credentialService,
      deviceRepository,
    });

  const trackedSessions = new Set<BridgeGatewaySession>();
  const pruneClosedSessions = (): void => {
    for (const session of trackedSessions) {
      if (session.state === "closed") trackedSessions.delete(session);
    }
  };

  const gateway = createBridgeGateway({
    ...options,
    authenticateDevice: async (deviceId, credential) =>
      (await credentialService.verify(deviceId, credential)).identity,
    onSession: (session) => {
      pruneClosedSessions();
      trackedSessions.add(session);
      options.onSession?.(session);
    },
  });

  const closeDeviceSessions = async (deviceId: string): Promise<void> => {
    const closes: Promise<void>[] = [];
    for (const session of trackedSessions) {
      if (session.state === "closed") {
        trackedSessions.delete(session);
        continue;
      }
      if (session.identity?.deviceId === deviceId) {
        trackedSessions.delete(session);
        closes.push(session.close("NORMAL"));
      }
    }
    await Promise.allSettled(closes);
  };

  return Object.freeze({
    gateway,
    deviceRepository,
    credentialRepository,
    credentialService,
    pairingService,
    pairingCredentialCompletionService,
    async revokeDeviceCredential(deviceId: string) {
      const revoked = await credentialService.revoke(deviceId);
      await closeDeviceSessions(deviceId);
      return revoked;
    },
    async rotateDeviceCredential(deviceId: string) {
      const rotated = await credentialService.rotate(deviceId);
      await closeDeviceSessions(deviceId);
      return rotated;
    },
    async stop() {
      trackedSessions.clear();
      await gateway.stop();
    },
  });
}
