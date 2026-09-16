import type { DeviceCredential } from "@doctmcp/schemas";
import {
  DeviceCredentialError,
  type DeviceCredentialRepository,
  DeviceCredentialService,
  InMemoryDeviceCredentialRepository,
  type IssuedDeviceCredential,
} from "./device-credential";
import {
  type DeviceCredentialLifecycleCoordinator,
  InMemoryDeviceCredentialLifecycleCoordinator,
} from "./device-credential-lifecycle";
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
  type CompletedPairingCredential,
  InMemoryPairingCredentialCompletionRepository,
  PairingCredentialCompletionError,
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
  readonly credentialLifecycleCoordinator?: DeviceCredentialLifecycleCoordinator;
}

export type RuntimePairingCredentialCompletionService = Pick<
  PairingCredentialCompletionService,
  "claimAndIssue" | "resumeClaimedPairing" | "acknowledgeDelivery"
>;

export interface DoctmcpServerRuntime {
  readonly gateway: BridgeGateway;
  readonly deviceRepository: DeviceRepository;
  readonly pairingService: PairingService;
  readonly pairingCredentialCompletionService: RuntimePairingCredentialCompletionService;
  revokeDeviceCredential(deviceId: string): Promise<DeviceCredential>;
  rotateDeviceCredential(deviceId: string): Promise<IssuedDeviceCredential>;
  stop(): Promise<void>;
}

export function createDoctmcpServerRuntime(
  options: CreateDoctmcpServerRuntimeOptions = {},
): DoctmcpServerRuntime {
  const {
    deviceRepository: configuredDeviceRepository,
    credentialRepository: configuredCredentialRepository,
    pairingRepository: configuredPairingRepository,
    pairingCredentialCompletionRepository:
      configuredPairingCredentialCompletionRepository,
    credentialLifecycleCoordinator: configuredCredentialLifecycleCoordinator,
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
  const credentialLifecycleCoordinator =
    configuredCredentialLifecycleCoordinator ??
    new InMemoryDeviceCredentialLifecycleCoordinator();

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

  const runCredentialLifecycleOperation = <T>(
    deviceId: string,
    operation: () => Promise<T>,
  ): Promise<T> =>
    credentialLifecycleCoordinator.runExclusive(deviceId, async () => {
      beginCredentialMutation(deviceId);
      try {
        await waitForSessionReadyDrain(deviceId);
        if (stopping) throw new Error("Server runtime is stopping");
        return await operation();
      } finally {
        await waitForAuthenticationDrain(deviceId);
        endCredentialMutation(deviceId);
      }
    });

  const recoverCredentialGenerationInsideLifecycle = async (
    deviceId: string,
    expectedCredentialId: string,
    expectedCredentialVersion: number,
    credentialId: string,
  ): Promise<IssuedDeviceCredential> => {
    const issued = await credentialService.rotateExpectedWithCredentialId(
      deviceId,
      expectedCredentialId,
      expectedCredentialVersion,
      credentialId,
    );
    await closeDeviceSessions(deviceId);
    return issued;
  };

  const rawPairingCredentialCompletionService =
    new PairingCredentialCompletionService({
      pairingService,
      credentialService,
      deviceRepository,
      completionRepository: pairingCredentialCompletionRepository,
      recoverExistingCredential: recoverCredentialGenerationInsideLifecycle,
    });

  const completionUnavailable = (): PairingCredentialCompletionError =>
    new PairingCredentialCompletionError(
      "PAIRING_COMPLETION_UNAVAILABLE",
      "Pairing credential completion không khả dụng.",
    );

  const getActiveCredentialOrNull = async (
    deviceId: string,
  ): Promise<DeviceCredential | null> => {
    try {
      return await credentialService.getActive(deviceId);
    } catch (error) {
      if (
        error instanceof DeviceCredentialError &&
        error.code === "CREDENTIAL_UNAVAILABLE"
      ) {
        return null;
      }
      throw error;
    }
  };

  const requireCompletionStillActive = async (
    completed: CompletedPairingCredential,
  ): Promise<CompletedPairingCredential> => {
    const active = await getActiveCredentialOrNull(completed.device.deviceId);
    if (
      !active ||
      active.credentialId !== completed.credential.credentialId ||
      active.version !== completed.credential.version
    ) {
      throw completionUnavailable();
    }
    return completed;
  };

  const getClaimedDeviceForOwner = async (
    pairingSessionId: string,
    ownerId: string,
  ) => {
    const session = await pairingService.getPairingSession(pairingSessionId);
    if (session?.state !== "claimed" || session.deviceId === undefined) {
      return null;
    }
    return deviceRepository.getForOwner(ownerId, session.deviceId);
  };

  const claimAndIssue: PairingCredentialCompletionService["claimAndIssue"] =
    async (pairingCode, input, context = {}) => {
      const claimed = await pairingService.claimPairingCode(
        pairingCode,
        input,
        context,
      );
      return runCredentialLifecycleOperation(
        claimed.device.deviceId,
        async () => {
          const completed =
            await rawPairingCredentialCompletionService.resumeClaimedPairing(
              claimed.session.pairingSessionId,
              claimed.device.ownerId,
            );
          return requireCompletionStillActive(completed);
        },
      );
    };

  const resumeClaimedPairing: PairingCredentialCompletionService["resumeClaimedPairing"] =
    async (pairingSessionId, ownerId) => {
      const device = await getClaimedDeviceForOwner(pairingSessionId, ownerId);
      if (!device) {
        return rawPairingCredentialCompletionService.resumeClaimedPairing(
          pairingSessionId,
          ownerId,
        );
      }

      return runCredentialLifecycleOperation(device.deviceId, async () => {
        const completed =
          await rawPairingCredentialCompletionService.resumeClaimedPairing(
            pairingSessionId,
            ownerId,
          );
        return requireCompletionStillActive(completed);
      });
    };

  const acknowledgeDelivery: PairingCredentialCompletionService["acknowledgeDelivery"] =
    async (input) => {
      const device = await getClaimedDeviceForOwner(
        input.pairingSessionId,
        input.ownerId,
      );
      if (!device) {
        return rawPairingCredentialCompletionService.acknowledgeDelivery(input);
      }

      return runCredentialLifecycleOperation(device.deviceId, async () => {
        const persisted = await pairingCredentialCompletionRepository.get(
          input.pairingSessionId,
        );
        if (
          persisted?.state === "pending" &&
          persisted.deviceId === device.deviceId &&
          persisted.credentialId === input.credentialId &&
          persisted.credentialVersion === input.credentialVersion
        ) {
          const active = await getActiveCredentialOrNull(device.deviceId);
          if (
            !active ||
            active.credentialId !== input.credentialId ||
            active.version !== input.credentialVersion
          ) {
            throw completionUnavailable();
          }
        }

        await rawPairingCredentialCompletionService.acknowledgeDelivery(input);
      });
    };

  const pairingCredentialCompletionService = Object.freeze({
    claimAndIssue,
    resumeClaimedPairing,
    acknowledgeDelivery,
  });

  const revokeDeviceCredentialInternal = async (
    deviceId: string,
  ): Promise<DeviceCredential> => {
    const current = await credentialService.getActive(deviceId);
    return runCredentialLifecycleOperation(current.deviceId, async () => {
      const revoked = await credentialRepository.revoke({
        deviceId: current.deviceId,
        expectedCredentialId: current.credentialId,
        expectedVersion: current.version,
        revokedAt: new Date(),
      });
      if (!revoked) {
        throw new DeviceCredentialError(
          "CREDENTIAL_UNAVAILABLE",
          "Device credential không khả dụng.",
        );
      }
      await closeDeviceSessions(current.deviceId);
      return revoked;
    });
  };

  const rotateDeviceCredentialInternal = async (
    deviceId: string,
  ): Promise<IssuedDeviceCredential> => {
    const current = await credentialService.getActive(deviceId);
    return runCredentialLifecycleOperation(current.deviceId, async () => {
      const rotated = await credentialService.rotateExpected(
        current.deviceId,
        current.credentialId,
        current.version,
      );
      await closeDeviceSessions(current.deviceId);
      return rotated;
    });
  };

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
