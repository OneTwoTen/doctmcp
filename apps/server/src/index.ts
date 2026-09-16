import { createDoctmcpServerRuntime } from "./server-runtime";

export const SERVER_COMPONENT = "doctmcp-server";

export {
  BridgeClientTransport,
  BridgeClientTransportError,
  type BridgeClientTransportErrorCode,
} from "./bridge-client-transport";
export {
  createDeviceCredentialInvalidationEvent,
  type CreateDeviceCredentialInvalidationEventInput,
  DEFAULT_CREDENTIAL_INVALIDATION_BOUND_MS,
  type DeviceCredentialInvalidationBus,
  type DeviceCredentialInvalidationEvent,
  type DeviceCredentialInvalidationHandler,
  type DeviceCredentialInvalidationKind,
  InMemoryDeviceCredentialInvalidationBus,
} from "./device-credential-invalidation";
export {
  DEVICE_CREDENTIAL_ENTROPY_BITS,
  DEVICE_CREDENTIAL_SECRET_BYTES,
  type DeviceCredentialClock,
  DeviceCredentialError,
  type DeviceCredentialErrorCode,
  type DeviceCredentialIdGenerator,
  type DeviceCredentialRepository,
  type DeviceCredentialSecretGenerator,
  DeviceCredentialService,
  type DeviceCredentialServiceOptions,
  digestDeviceCredentialSecret,
  generateDeviceCredentialSecret,
  InMemoryDeviceCredentialRepository,
  type IssuedDeviceCredential,
  type VerifiedDeviceCredential,
} from "./device-credential";
export {
  type DeviceCredentialLifecycleCoordinator,
  InMemoryDeviceCredentialLifecycleCoordinator,
} from "./device-credential-lifecycle";
export {
  type DeviceClock,
  type DeviceIdGenerator,
  type DeviceRepository,
  DeviceRepositoryError,
  type DeviceRepositoryErrorCode,
  InMemoryDeviceRepository,
  type InMemoryDeviceRepositoryOptions,
} from "./device-repository";
export {
  type ActiveDeviceSession,
  DEFAULT_DEVICE_HEARTBEAT_INTERVAL_MS,
  DEFAULT_DEVICE_HEARTBEAT_TIMEOUT_MS,
  type DeviceSessionCredentialGeneration,
  DeviceSessionRegistry,
  type DeviceSessionRegistryOptions,
  type DeviceSessionStatusSnapshot,
  type RegisterDeviceSessionResult,
} from "./device-session-registry";
export {
  type BridgeDeviceAuthenticator,
  type BridgeGateway,
  BridgeGatewayError,
  type BridgeGatewayLogger,
  type BridgeGatewaySession,
  type BridgeSessionClosedHandler,
  type BridgeSessionHeartbeatHandler,
  type BridgeSessionReadyGuard,
  type BridgeSessionReadyValidator,
  type CreateBridgeGatewayOptions,
  createBridgeGateway,
  DEFAULT_BRIDGE_PATH,
} from "./gateway";
export {
  type ClaimPairingRecordInput,
  type ClaimPairingResult,
  type CreatePairingRecordInput,
  type CreatePairingSessionResult,
  DEFAULT_PAIRING_TTL_MS,
  digestPairingCode,
  formatPairingCode,
  generateSecurePairingCode,
  InMemoryPairingSessionRepository,
  normalizePairingCode,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_ENTROPY_BITS,
  PAIRING_CODE_GROUP_SIZE,
  PAIRING_CODE_SYMBOLS,
  PAIRING_CREATE_MAX_ATTEMPTS,
  type PairingClaimAttempt,
  type PairingClaimAttemptGuard,
  type PairingClaimContext,
  type PairingClock,
  type PairingCodeGenerator,
  PairingRepositoryError,
  type PairingRepositoryErrorCode,
  PairingService,
  PairingServiceError,
  type PairingServiceErrorCode,
  type PairingServiceOptions,
  type PairingSessionIdGenerator,
  type PairingSessionRepository,
} from "./pairing";
export {
  type AcknowledgePairingCredentialDeliveryInput,
  type CompletedPairingCredential,
  InMemoryPairingCredentialCompletionRepository,
  PairingCredentialCompletionError,
  type PairingCredentialCompletionErrorCode,
  type PairingCredentialCompletionOptions,
  type PairingCredentialCompletionRecord,
  type PairingCredentialCompletionRepository,
  PairingCredentialCompletionService,
  type PairingCredentialCompletionState,
  type PairingCredentialDelivery,
  toPairingCredentialDelivery,
} from "./pairing-credential-completion";
export {
  type CreateDoctmcpServerRuntimeOptions,
  createDoctmcpServerRuntime,
  type DoctmcpServerRuntime,
  type RuntimePairingCredentialCompletionService,
} from "./server-runtime";

if (import.meta.main) {
  const runtime = createDoctmcpServerRuntime({
    port: Number(process.env.PORT ?? 3000),
  });
  console.log(`${SERVER_COMPONENT}: listening on ${runtime.gateway.url}`);
}
