import type { DeviceCredential } from "@doctmcp/schemas";
import {
  type DeviceCredentialRepository,
  DeviceCredentialService,
  InMemoryDeviceCredentialRepository,
  type IssuedDeviceCredential,
} from "./device-credential";
import {
  type DeviceRepository,
  InMemoryDeviceRepository,
} from "./device-repository";
import {
  type BridgeGateway,
  type BridgeGatewaySession,
  type CreateBridgeGatewayOptions,
  createBridgeGateway,
} from "./gateway";
import {
  InMemoryPairingSessionRepository,
  type PairingSessionRepository,
  PairingService,
} from "./pairing";
import { PairingCredentialCompletionService } from "./pairing-credential-completion";

export interface CreateDoctmcpServerRuntimeOptions
  extends Omit<
    CreateBridgeGatewayOptions,
    "authenticateDevice" | "allowLegacyUnauthenticated" | "onSession"
  > {
  readonly onSession?: (session: BridgeGatewaySession) => void;
  readonly deviceRepository?: DeviceRepository;
  readonly credentialRepository?: DeviceCredentialRepository;
  readonly pairingRepository?: PairingSessionRepository;
}

export interface DoctmcpServerRuntime {
  readonly gateway: BridgeGateway;
  readonly deviceRepository: DeviceRepository;
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
 * unauthenticated mode không được expose từ composition root này. Repository adapters có
 * thể được inject để production thay in-memory bằng persistence thật mà không expose
 * credential mutation service ra ngoài runtime security boundary.
 */
export function createDoctmcpServerRuntime(
  options: CreateDoctmcpServerRuntimeOptions = {},
): DoctmcpServerRuntime {
  const {
    deviceRepository: configuredDeviceRepository,
    credentialRepository: configuredCredentialRepository,
    pairingRepository: configuredPairingRepository,
    onSession,
    ...gatewayOptions
  } = options;

  const deviceRepository =
    configuredDeviceRepository ?? new InMemoryDeviceRepository();
  const credentialRepository =
    configuredCredentialRepository ?? new InMemoryDeviceCredentialRepository();
  const credentialService = new DeviceCredentialService({
    repository: credentialRepository,
    deviceRepository,
  });
  const pairingRepository =
    configuredPairingRepository ??
    new InMemoryPairingSessionRepository(deviceRepository);
  const pairingService = new PairingService({ repository: pairingRepository });

  const trackedSessions = new Set<BridgeGatewaySession>();
  const credentialMutationCounts = new Map<string, number>();
  const authenticationCounts = new Map<string, number>();
  const authenticationDrainWaiters = new Map<
    string,
    Set<() => void>
  >();

  const pruneClosedSessions = (): void => {
    for (const session of trackedSessions) {
      if (session.state === "closed") trackedSessions.delete(session);
    }
  };

  const isCredentialMutationActive = (deviceId: string): boolean =>
    (credentialMutationCounts.get(deviceId) ?? 0) > 0;

  const beginCredentialMutation = (deviceId: string): void => {
    credentialMutationCounts.set(
      deviceId,
      (credentialMutationCounts.get(deviceId) ?? 0) + 1,
    );
  };

  const endCredentialMutation = (deviceId: string): void => {
    const remaining = (credentialMutationCounts.get(deviceId) ?? 1) - 1;
    if (remaining <= 0) {
      credentialMutationCounts.delete(deviceId);
      return;
    }
    credentialMutationCounts.set(deviceId, remaining);
  };

  const beginAuthentication = (deviceId: string): void => {
    authenticationCounts.set(
      deviceId,
      (authenticationCounts.get(deviceId) ?? 0) + 1,
    );
  };

  const endAuthentication = (deviceId: string): void => {
    const remaining = (authenticationCounts.get(deviceId) ?? 1) - 1;
    if (remaining > 0) {
      authenticationCounts.set(deviceId, remaining);
      return;
    }

    authenticationCounts.delete(deviceId);
    const waiters = authenticationDrainWaiters.get(deviceId);
    authenticationDrainWaiters.delete(deviceId);
    for (const resolve of waiters ?? []) resolve();
  };

  const waitForAuthenticationDrain = (deviceId: string): Promise<void> => {
    if ((authenticationCounts.get(deviceId) ?? 0) === 0) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const waiters = authenticationDrainWaiters.get(deviceId) ?? new Set();
      waiters.add(resolve);
      authenticationDrainWaiters.set(deviceId, waiters);
    });
  };

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

  const nextEventLoopTurn = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

  const runCredentialMutation = async <T>(
    deviceId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    beginCredentialMutation(deviceId);
    try {
      const result = await operation();

      // Đóng session đã ready ngay sau mutation.
      await closeDeviceSessions(deviceId);

      // Auth bắt đầu trước mutation phải kết thúc trước khi boundary được mở lại.
      // Authenticator sẽ tự reject nếu thấy mutation active sau verify.
      await waitForAuthenticationDrain(deviceId);

      // Nếu authenticator đã return ngay trước khi mutation bắt đầu, continuation của
      // gateway có thể đang nằm trong microtask queue. Giữ mutation active qua một turn
      // để onSession thấy boundary và reject/close session đó trước khi expose ra caller.
      await nextEventLoopTurn();
      await closeDeviceSessions(deviceId);
      return result;
    } finally {
      endCredentialMutation(deviceId);
    }
  };

  const revokeDeviceCredentialInternal = (
    deviceId: string,
  ): Promise<DeviceCredential> =>
    runCredentialMutation(deviceId, () => credentialService.revoke(deviceId));

  const rotateDeviceCredentialInternal = (
    deviceId: string,
  ): Promise<IssuedDeviceCredential> =>
    runCredentialMutation(deviceId, () => credentialService.rotate(deviceId));

  const pairingCredentialCompletionService =
    new PairingCredentialCompletionService({
      pairingService,
      credentialService,
      deviceRepository,
      recoverExistingCredential: rotateDeviceCredentialInternal,
    });

  const gateway = createBridgeGateway({
    ...gatewayOptions,
    authenticateDevice: async (deviceId, credential) => {
      if (isCredentialMutationActive(deviceId)) {
        throw new Error("Device credential mutation is in progress");
      }

      beginAuthentication(deviceId);
      try {
        if (isCredentialMutationActive(deviceId)) {
          throw new Error("Device credential mutation is in progress");
        }
        const verified = await credentialService.verify(deviceId, credential);
        if (isCredentialMutationActive(deviceId)) {
          throw new Error("Device credential changed during authentication");
        }
        return verified.identity;
      } finally {
        endAuthentication(deviceId);
      }
    },
    onSession: (session) => {
      pruneClosedSessions();
      const deviceId = session.identity?.deviceId;
      if (deviceId && isCredentialMutationActive(deviceId)) {
        void session.close("NORMAL");
        return;
      }
      trackedSessions.add(session);
      onSession?.(session);
    },
  });

  return Object.freeze({
    gateway,
    deviceRepository,
    pairingService,
    pairingCredentialCompletionService,
    revokeDeviceCredential: revokeDeviceCredentialInternal,
    rotateDeviceCredential: rotateDeviceCredentialInternal,
    async stop() {
      trackedSessions.clear();
      authenticationDrainWaiters.clear();
      authenticationCounts.clear();
      credentialMutationCounts.clear();
      await gateway.stop();
    },
  });
}
