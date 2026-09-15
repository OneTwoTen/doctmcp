import { createBridgeGateway } from "./gateway";

export const SERVER_COMPONENT = "doctmcp-server";

export {
  BridgeClientTransport,
  BridgeClientTransportError,
  type BridgeClientTransportErrorCode,
} from "./bridge-client-transport";
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
  type BridgeGateway,
  BridgeGatewayError,
  type BridgeGatewayLogger,
  type BridgeGatewaySession,
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

if (import.meta.main) {
  const gateway = createBridgeGateway({
    port: Number(process.env.PORT ?? 3000),
  });
  console.log(`${SERVER_COMPONENT}: listening on ${gateway.url}`);
}
