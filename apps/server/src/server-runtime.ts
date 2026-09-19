import type {
  AuthenticatedDeviceIdentity,
  DeviceCredential,
} from "@doctmcp/schemas";
import {
  DeviceCredentialError,
  type DeviceCredentialRepository,
  DeviceCredentialService,
  InMemoryDeviceCredentialRepository,
  type IssuedDeviceCredential,
} from "./device-credential";
import {
  createDeviceCredentialInvalidationEvent,
  DEFAULT_CREDENTIAL_INVALIDATION_BOUND_MS,
  type DeviceCredentialInvalidationBus,
  type DeviceCredentialInvalidationKind,
  InMemoryDeviceCredentialInvalidationBus,
} from "./device-credential-invalidation";
import {
  type DeviceCredentialLifecycleCoordinator,
  InMemoryDeviceCredentialLifecycleCoordinator,
} from "./device-credential-lifecycle";
import {
  type DeviceRepository,
  InMemoryDeviceRepository,
} from "./device-repository";
import { DeviceRoutingService } from "./device-routing";
import {
  DEFAULT_DEVICE_HEARTBEAT_INTERVAL_MS,
  DEFAULT_DEVICE_HEARTBEAT_TIMEOUT_MS,
  type DeviceSessionCredentialGeneration,
  DeviceSessionRegistry,
  type DeviceSessionStatusSnapshot,
} from "./device-session-registry";
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
  InMemoryPairingAbuseGuard,
  type PairingAbuseGuard,
} from "./pairing-abuse-guard";
import { PairingChannelCoordinator } from "./pairing-channel";
import { createPairingChannelWebSocketRoute } from "./pairing-channel-route";
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
    | "onHeartbeat"
    | "onSessionClosed"
    | "websocketRoutes"
  > {
  readonly onSession?: (session: BridgeGatewaySession) => void;
  readonly websocketRoutes?: CreateBridgeGatewayOptions["websocketRoutes"];
  readonly deviceRepository?: DeviceRepository;
  readonly credentialRepository?: DeviceCredentialRepository;
  readonly pairingRepository?: PairingSessionRepository;
  readonly pairingAbuseGuard?: PairingAbuseGuard;
  readonly pairingCredentialCompletionRepository?: PairingCredentialCompletionRepository;
  readonly credentialLifecycleCoordinator?: DeviceCredentialLifecycleCoordinator;
  readonly deviceSessionRegistry?: DeviceSessionRegistry;
  readonly credentialInvalidationBus?: DeviceCredentialInvalidationBus;
  readonly credentialInvalidationPublishTimeoutMs?: number;
}

export type RuntimePairingCredentialCompletionService = Pick<
  PairingCredentialCompletionService,
  | "claimAndIssue"
  | "resumeClaimedPairing"
  | "acknowledgeDelivery"
  | "forgetPendingCompletion"
>;

export interface DoctmcpServerRuntime {
  readonly gateway: BridgeGateway;
  readonly deviceRepository: DeviceRepository;
  readonly deviceSessionRegistry: DeviceSessionRegistry;
  readonly deviceRouter: DeviceRoutingService;
  readonly pairingService: PairingService;
  readonly pairingAbuseGuard: PairingAbuseGuard;
  readonly pairingChannelCoordinator: PairingChannelCoordinator;
  readonly pairingCredentialCompletionService: RuntimePairingCredentialCompletionService;
  getDeviceStatus(deviceId: string): DeviceSessionStatusSnapshot;
  revokeDeviceCredential(deviceId: string): Promise<DeviceCredential>;
  rotateDeviceCredential(deviceId: string): Promise<IssuedDeviceCredential>;
  stop(): Promise<void>;
}

function generationFromCredential(
  credential: Pick<DeviceCredential, "credentialId" | "version">,
): DeviceSessionCredentialGeneration {
  return Object.freeze({
    credentialId: credential.credentialId,
    credentialVersion: credential.version,
  });
}

export function createDoctmcpServerRuntime(
  options: CreateDoctmcpServerRuntimeOptions = {},
): DoctmcpServerRuntime {
  const {
    deviceRepository: configuredDeviceRepository,
    credentialRepository: configuredCredentialRepository,
    pairingRepository: configuredPairingRepository,
    pairingAbuseGuard: configuredPairingAbuseGuard,
    pairingCredentialCompletionRepository:
      configuredPairingCredentialCompletionRepository,
    credentialLifecycleCoordinator: configuredCredentialLifecycleCoordinator,
    deviceSessionRegistry: configuredDeviceSessionRegistry,
    credentialInvalidationBus: configuredCredentialInvalidationBus,
    credentialInvalidationPublishTimeoutMs:
      configuredCredentialInvalidationPublishTimeoutMs,
    heartbeatIntervalMs: configuredHeartbeatIntervalMs,
    heartbeatTimeoutMs: configuredHeartbeatTimeoutMs,
    logger,
    onSession,
    websocketRoutes: configuredWebSocketRoutes,
    ...gatewayOptions
  } = options;

  const heartbeatTimeoutMs =
    configuredHeartbeatTimeoutMs ??
    configuredDeviceSessionRegistry?.heartbeatTimeoutMs ??
    DEFAULT_DEVICE_HEARTBEAT_TIMEOUT_MS;
  const heartbeatIntervalMs =
    configuredHeartbeatIntervalMs ?? DEFAULT_DEVICE_HEARTBEAT_INTERVAL_MS;
  const credentialInvalidationPublishTimeoutMs =
    configuredCredentialInvalidationPublishTimeoutMs ??
    DEFAULT_CREDENTIAL_INVALIDATION_BOUND_MS;
  if (
    configuredDeviceSessionRegistry &&
    configuredDeviceSessionRegistry.heartbeatTimeoutMs !== heartbeatTimeoutMs
  ) {
    throw new Error(
      "Configured DeviceSessionRegistry heartbeat timeout must match runtime heartbeatTimeoutMs.",
    );
  }
  if (
    !Number.isFinite(credentialInvalidationPublishTimeoutMs) ||
    credentialInvalidationPublishTimeoutMs <= 0
  ) {
    throw new Error(
      "credentialInvalidationPublishTimeoutMs must be a positive finite number.",
    );
  }

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
  const pairingAbuseGuard =
    configuredPairingAbuseGuard ?? new InMemoryPairingAbuseGuard();
  const pairingService = new PairingService({
    repository: pairingRepository,
    claimAttemptGuard: pairingAbuseGuard,
  });
  const pairingCredentialCompletionRepository =
    configuredPairingCredentialCompletionRepository ??
    new InMemoryPairingCredentialCompletionRepository();
  const credentialLifecycleCoordinator =
    configuredCredentialLifecycleCoordinator ??
    new InMemoryDeviceCredentialLifecycleCoordinator();
  const deviceSessionRegistry =
    configuredDeviceSessionRegistry ??
    new DeviceSessionRegistry({ heartbeatTimeoutMs });
  const deviceRouter = new DeviceRoutingService({
    deviceRepository,
    credentialRepository,
    deviceSessionRegistry,
  });
  const credentialInvalidationBus =
    configuredCredentialInvalidationBus ??
    new InMemoryDeviceCredentialInvalidationBus();

  const credentialGenerationByIdentity = new WeakMap<
    AuthenticatedDeviceIdentity,
    DeviceSessionCredentialGeneration
  >();
  const credentialMutationCounts = new Map<string, number>();
  const authenticationCounts = new Map<string, number>();
  const authenticationDrainWaiters = new Map<string, Set<() => void>>();
  const sessionReadyCounts = new Map<string, number>();
  const sessionReadyDrainWaiters = new Map<string, Set<() => void>>();
  let stopping = false;

  const log = (
    event: string,
    details?: Readonly<Record<string, string>>,
  ): void => logger?.(event, details);

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

  const evictCredentialGeneration = async (
    deviceId: string,
    generation: DeviceSessionCredentialGeneration,
    nativeReason: "CREDENTIAL_INVALIDATED" | "SESSION_REPLACED",
  ): Promise<void> => {
    const evicted = deviceSessionRegistry.evictGeneration(deviceId, generation);
    if (!evicted) return;
    log("device.session.evicted", {
      deviceId,
      sessionId: evicted.session.id,
      reason: nativeReason,
    });
    await evicted.session.close("NORMAL", nativeReason);
  };

  const publishCredentialInvalidation = async (
    deviceId: string,
    generation: DeviceSessionCredentialGeneration,
    kind: DeviceCredentialInvalidationKind,
  ): Promise<void> => {
    const event = createDeviceCredentialInvalidationEvent({
      kind,
      deviceId,
      credentialId: generation.credentialId,
      credentialVersion: generation.credentialVersion,
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        credentialInvalidationBus.publish(event),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(new Error("Credential invalidation publish timed out")),
            credentialInvalidationPublishTimeoutMs,
          );
        }),
      ]);
    } catch {
      log("device.credential.invalidation.degraded", {
        deviceId,
        eventId: event.eventId,
        kind,
        timeoutMs: String(credentialInvalidationPublishTimeoutMs),
      });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };

  const invalidateCredentialGeneration = async (
    deviceId: string,
    generation: DeviceSessionCredentialGeneration,
    kind: DeviceCredentialInvalidationKind,
  ): Promise<void> => {
    await evictCredentialGeneration(
      deviceId,
      generation,
      "CREDENTIAL_INVALIDATED",
    );
    await publishCredentialInvalidation(deviceId, generation, kind);
  };

  const unsubscribeCredentialInvalidation = credentialInvalidationBus.subscribe(
    async (event) => {
      if (stopping) return;
      await evictCredentialGeneration(
        event.deviceId,
        {
          credentialId: event.credentialId,
          credentialVersion: event.credentialVersion,
        },
        "CREDENTIAL_INVALIDATED",
      );
    },
  );

  const runCredentialLifecycleOperation = async <T>(
    deviceId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    beginCredentialMutation(deviceId);
    try {
      return await credentialLifecycleCoordinator.runExclusive(
        deviceId,
        async () => {
          try {
            await waitForSessionReadyDrain(deviceId);
            if (stopping) throw new Error("Server runtime is stopping");
            return await operation();
          } finally {
            await waitForAuthenticationDrain(deviceId);
          }
        },
      );
    } finally {
      endCredentialMutation(deviceId);
    }
  };

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
    await invalidateCredentialGeneration(
      deviceId,
      {
        credentialId: expectedCredentialId,
        credentialVersion: expectedCredentialVersion,
      },
      "rotated",
    );
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
      const admissionId = `admission:${crypto.randomUUID()}`;
      const admitted =
        await pairingCredentialCompletionRepository.reserve(admissionId);
      if (!admitted) throw completionUnavailable();

      let claimed: Awaited<ReturnType<PairingService["claimPairingCode"]>>;
      try {
        claimed = await pairingService.claimPairingCode(
          pairingCode,
          input,
          context,
        );
      } catch (error) {
        await pairingCredentialCompletionRepository
          .delete(admissionId)
          .catch(() => undefined);
        throw error;
      }

      const transferred =
        await pairingCredentialCompletionRepository.transferReservation(
          admissionId,
          claimed.session.pairingSessionId,
        );
      if (!transferred) {
        await pairingCredentialCompletionRepository
          .delete(admissionId)
          .catch(() => undefined);
        throw completionUnavailable();
      }

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
    forgetPendingCompletion: (
      pairingSessionId: string,
      preserveDelivered = false,
    ) =>
      rawPairingCredentialCompletionService.forgetPendingCompletion(
        pairingSessionId,
        preserveDelivered,
      ),
  });

  const pairingChannelCoordinator = new PairingChannelCoordinator({
    acknowledgeDelivery: (input) =>
      pairingCredentialCompletionService.acknowledgeDelivery(input),
    cancelPairingSession: async (pairingSessionId) => {
      await pairingService.cancelPairingSession(pairingSessionId);
    },
    forgetPendingCompletion: (pairingSessionId, preserveDelivered) =>
      pairingCredentialCompletionService.forgetPendingCompletion(
        pairingSessionId,
        preserveDelivered,
      ),
  });

  const revokeDeviceCredentialInternal = async (
    deviceId: string,
  ): Promise<DeviceCredential> => {
    const lifecycleDeviceId = deviceId.toLowerCase();
    const currentPromise = credentialService.getActive(deviceId);
    return runCredentialLifecycleOperation(lifecycleDeviceId, async () => {
      const current = await currentPromise;
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
      await invalidateCredentialGeneration(
        current.deviceId,
        generationFromCredential(current),
        "revoked",
      );
      return revoked;
    });
  };

  const rotateDeviceCredentialInternal = async (
    deviceId: string,
  ): Promise<IssuedDeviceCredential> => {
    const lifecycleDeviceId = deviceId.toLowerCase();
    const currentPromise = credentialService.getActive(deviceId);
    return runCredentialLifecycleOperation(lifecycleDeviceId, async () => {
      const current = await currentPromise;
      const rotated = await credentialService.rotateExpected(
        current.deviceId,
        current.credentialId,
        current.version,
      );
      await invalidateCredentialGeneration(
        current.deviceId,
        generationFromCredential(current),
        "rotated",
      );
      return rotated;
    });
  };

  const gateway = createBridgeGateway({
    ...gatewayOptions,
    websocketRoutes: [
      ...(configuredWebSocketRoutes ?? []),
      createPairingChannelWebSocketRoute(pairingChannelCoordinator),
    ],
    logger,
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
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
      credentialGenerationByIdentity.set(
        identity,
        generationFromCredential(verified.credential),
      );
    },
    onSession: (session) => {
      if (session.identity) {
        const generation = credentialGenerationByIdentity.get(session.identity);
        if (!generation) {
          throw new Error(
            "Authenticated session credential generation is missing",
          );
        }
        credentialGenerationByIdentity.delete(session.identity);
        const registered = deviceSessionRegistry.register(session, generation);
        if (registered.replaced) {
          log("device.session.replaced", {
            deviceId: registered.current.deviceId,
            oldSessionId: registered.replaced.session.id,
            newSessionId: registered.current.session.id,
          });
          void registered.replaced.session.close("NORMAL", "SESSION_REPLACED");
        }
      }
      onSession?.(session);
    },
    onHeartbeat: async (session) => {
      const registered = deviceSessionRegistry.getBySession(session);
      if (!registered || !session.identity) {
        throw new Error("Heartbeat session is not registered");
      }
      const active = await credentialRepository.getActive(registered.deviceId);
      if (
        !active ||
        active.credentialId !== registered.credentialGeneration.credentialId ||
        active.version !== registered.credentialGeneration.credentialVersion
      ) {
        deviceSessionRegistry.evictSession(session);
        throw new Error("Heartbeat credential generation is no longer active");
      }
      if (!deviceSessionRegistry.markHeartbeat(session)) {
        throw new Error("Heartbeat session was replaced during validation");
      }
    },
    onSessionClosed: (session) => {
      if (session.identity)
        credentialGenerationByIdentity.delete(session.identity);
      deviceSessionRegistry.evictSession(session);
    },
  });

  const pairingPruneInterval = setInterval(() => {
    if (stopping) return;
    void pairingService.pruneExpiredPairingSessions().catch(() => undefined);
  }, 60_000);

  return Object.freeze({
    gateway,
    deviceRepository,
    deviceSessionRegistry,
    deviceRouter,
    pairingService,
    pairingAbuseGuard,
    pairingChannelCoordinator,
    pairingCredentialCompletionService,
    getDeviceStatus(deviceId: string) {
      return deviceSessionRegistry.getStatus(deviceId);
    },
    revokeDeviceCredential: revokeDeviceCredentialInternal,
    rotateDeviceCredential: rotateDeviceCredentialInternal,
    async stop() {
      if (stopping) return;
      stopping = true;
      clearInterval(pairingPruneInterval);
      unsubscribeCredentialInvalidation();
      resolveDrainWaiters(authenticationDrainWaiters);
      resolveDrainWaiters(sessionReadyDrainWaiters);
      await pairingChannelCoordinator.close();
      await gateway.stop();
      deviceSessionRegistry.clear();
      authenticationCounts.clear();
      sessionReadyCounts.clear();
      credentialMutationCounts.clear();
    },
  });
}
