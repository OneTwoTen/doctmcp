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
  PairingService,
  type PairingSessionRepository,
} from "./pairing";
import {
  InMemoryPairingCredentialCompletionRepository,
  type PairingCredentialCompletionRepository,
  PairingCredentialCompletionService,
} from "./pairing-credential-completion";

export interface CreateDoctmcpServerRuntimeOptions
  extends Omit<
    CreateBridgeGatewayOptions,
    | "authenticateDevice"
    | "allowLegacyUnauthenticated"
    | "beginSessionReady"
    | "validateSessionReady"
    | "onSession"
  > {
  readonly onSession?: (session: BridgeGatewaySession) => void;
  readonly deviceRepository?: DeviceRepository;
  readonly credentialRepository?: DeviceCredentialRepository;
  readonly pairingRepository?: PairingSessionRepository;
  readonly pairingCredentialCompletionRepository?: PairingCredentialCompletionRepository;
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
    pairingCredentialCompletionRepository:
      configuredPairingCredentialCompletionRepository,
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
  const pairingCredentialCompletionRepository =
    configuredPairingCredentialCompletionRepository ??
    new InMemoryPairingCredentialCompletionRepository();

  const trackedSessions = new Set<BridgeGatewaySession>();
  const credentialMutationCounts = new Map<string, number>();
  const authenticationCounts = new Map<string, number>();
  const authenticationDrainWaiters = new Map<string, Set<() => void>>();
  const sessionReadyCounts = new Map<string, number>();
  const sessionReadyDrainWaiters = new Map<string, Set<() => void>>();
  let stopping = false;

  const pruneClosedSessions = (): void => {
    for (const session of trackedSessions) {
      if (session.state === "closed") trackedSessions.delete(session);
    }
  };

  const isCredentialMutationActive = (deviceId: string): boolean =>
    (credentialMutationCounts.get(deviceId) ?? 0) > 0;

  const beginCredentialMutation = (deviceId: string): void => {
    if (stopping) throw new Error("Server runtime is stopping");
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

  const resolveDrainWaiters = (
    waitersByDevice: Map<string, Set<() => void>>,
  ): void => {
    for (const waiters of waitersByDevice.values()) {
      for (const resolve of waiters) resolve();
    }
    waitersByDevice.clear();
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
    if (stopping || (authenticationCounts.get(deviceId) ?? 0) === 0) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const waiters = authenticationDrainWaiters.get(deviceId) ?? new Set();
      waiters.add(resolve);
      authenticationDrainWaiters.set(deviceId, waiters);
    });
  };

  const beginSessionReady = (deviceId: string): (() => void) => {
    if (stopping || isCredentialMutationActive(deviceId)) {
      throw new Error("Device credential mutation is in progress");
    }
    sessionReadyCounts.set(
      deviceId,
      (sessionReadyCounts.get(deviceId) ?? 0) + 1,
    );

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (sessionReadyCounts.get(deviceId) ?? 1) - 1;
      if (remaining > 0) {
        sessionReadyCounts.set(deviceId, remaining);
        return;
      }
      sessionReadyCounts.delete(deviceId);
      const waiters = sessionReadyDrainWaiters.get(deviceId);
      sessionReadyDrainWaiters.delete(deviceId);
      for (const resolve of waiters ?? []) resolve();
    };
  };

  const waitForSessionReadyDrain = (deviceId: string): Promise<void> => {
    if (stopping || (sessionReadyCounts.get(deviceId) ?? 0) === 0) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const waiters = sessionReadyDrainWaiters.get(deviceId) ?? new Set();
      waiters.add(resolve);
      sessionReadyDrainWaiters.set(deviceId, waiters);
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

  const runCredentialMutation = async <T>(
    deviceId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    beginCredentialMutation(deviceId);
    try {
      // Một handshake đã acquire ready lease được phép commit trong khi credential còn
      // hợp lệ. Mutation chỉ bắt đầu sau khi toàn bộ ready commit của device drain xong.
      await waitForSessionReadyDrain(deviceId);
      if (stopping) throw new Error("Server runtime is stopping");

      const result = await operation();
      await closeDeviceSessions(deviceId);

      // Auth bắt đầu trước mutation có thể đã đọc snapshot cũ. Giữ mutation boundary
      // active tới khi auth đó kết thúc để post-verify check reject deterministic.
      await waitForAuthenticationDrain(deviceId);
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
      completionRepository: pairingCredentialCompletionRepository,
      recoverExistingCredential: rotateDeviceCredentialInternal,
    });

  const gateway = createBridgeGateway({
    ...gatewayOptions,
    authenticateDevice: async (deviceId, credential) => {
      if (stopping || isCredentialMutationActive(deviceId)) {
        throw new Error("Device credential mutation is in progress");
      }

      beginAuthentication(deviceId);
      try {
        if (stopping || isCredentialMutationActive(deviceId)) {
          throw new Error("Device credential mutation is in progress");
        }
        const verified = await credentialService.verify(deviceId, credential);
        if (stopping || isCredentialMutationActive(deviceId)) {
          throw new Error("Device credential changed during authentication");
        }
        return verified.identity;
      } finally {
        endAuthentication(deviceId);
      }
    },
    beginSessionReady: (identity) => {
      if (!identity) return undefined;
      return beginSessionReady(identity.deviceId);
    },
    validateSessionReady: async (deviceId, credential, identity) => {
      const verified = await credentialService.verify(deviceId, credential);
      if (
        verified.identity.deviceId !== identity.deviceId ||
        verified.identity.ownerId !== identity.ownerId
      ) {
        throw new Error("Device credential changed before session readiness");
      }
    },
    onSession: (session) => {
      pruneClosedSessions();
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
      if (stopping) return;
      stopping = true;

      // Không clear waiter im lặng: mọi revoke/rotate đang drain phải settle khi shutdown.
      resolveDrainWaiters(authenticationDrainWaiters);
      resolveDrainWaiters(sessionReadyDrainWaiters);

      await gateway.stop();
      trackedSessions.clear();
      authenticationCounts.clear();
      sessionReadyCounts.clear();
      credentialMutationCounts.clear();
    },
  });
}
