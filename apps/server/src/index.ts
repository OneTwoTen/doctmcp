import { createOidcAccessTokenVerifier } from "./public-mcp-auth";
import { createPublicMcpEndpoint } from "./public-mcp-endpoint";
import { createPublicPairingEndpoint } from "./public-pairing-endpoint";
import { createDoctmcpServerRuntime } from "./server-runtime";

export const SERVER_COMPONENT = "doctmcp-server";

export {
  BridgeClientTransport,
  BridgeClientTransportError,
  type BridgeClientTransportErrorCode,
} from "./bridge-client-transport";
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
  type CreateDeviceCredentialInvalidationEventInput,
  createDeviceCredentialInvalidationEvent,
  DEFAULT_CREDENTIAL_INVALIDATION_BOUND_MS,
  type DeviceCredentialInvalidationBus,
  type DeviceCredentialInvalidationEvent,
  type DeviceCredentialInvalidationHandler,
  type DeviceCredentialInvalidationKind,
  InMemoryDeviceCredentialInvalidationBus,
} from "./device-credential-invalidation";
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
  DeviceRoutingError,
  type DeviceRoutingErrorCode,
  DeviceRoutingService,
  type DeviceRoutingServiceOptions,
  type ResolvedDeviceSession,
  type RoutedDeviceSnapshot,
} from "./device-routing";
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
  type BridgeGatewayHttpContext,
  type BridgeGatewayHttpHandler,
  type BridgeGatewayLogger,
  type BridgeGatewaySession,
  type BridgeSessionClosedHandler,
  type BridgeSessionHeartbeatHandler,
  type BridgeSessionReadyGuard,
  type BridgeSessionReadyValidator,
  type CreateBridgeGatewayOptions,
  createBridgeGateway,
  DEFAULT_BRIDGE_PATH,
  type GatewayWebSocketConnection,
  type GatewayWebSocketRoute,
} from "./gateway";
export {
  type ClaimPairingRecordInput,
  type ClaimPairingResult,
  type CreatePairingRecordInput,
  type CreatePairingSessionResult,
  DEFAULT_PAIRING_REPOSITORY_MAX_SESSIONS,
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
  InMemoryPairingAbuseGuard,
  type PairingAbuseGuard,
  type PairingAbuseGuardOptions,
} from "./pairing-abuse-guard";
export {
  PairingChannelCoordinator,
  type PairingChannelCoordinatorOptions,
  PairingChannelError,
  type PairingChannelErrorCode,
} from "./pairing-channel";
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
  createOidcAccessTokenVerifier,
  deriveOidcOwnerId,
  type OidcAccessTokenVerifier,
  type OidcAccessTokenVerifierOptions,
  type OidcFetch,
} from "./public-mcp-auth";
export {
  type CreatePublicMcpEndpointOptions,
  createPublicMcpEndpoint,
  type PublicMcpAuditEvent,
  type PublicMcpAuditSink,
  type PublicMcpEndpoint,
} from "./public-mcp-endpoint";
export {
  type CreatePublicPairingEndpointOptions,
  createPublicPairingEndpoint,
  PUBLIC_PAIRING_START_MAX_BODY_BYTES,
  PUBLIC_PAIRING_START_PATH,
  type PublicPairingEndpoint,
} from "./public-pairing-endpoint";
export { RoutedDeviceMcpClientRegistry } from "./routed-device-mcp-client-registry";
export {
  type CreateDoctmcpServerRuntimeOptions,
  createDoctmcpServerRuntime,
  type DoctmcpServerRuntime,
  type RuntimePairingCredentialCompletionService,
} from "./server-runtime";

export async function stopDoctmcpServer(
  publicMcp: { close(): Promise<void> } | undefined,
  runtime: { stop(): Promise<void> },
): Promise<void> {
  try {
    await publicMcp?.close();
  } finally {
    await runtime.stop();
  }
}

if (import.meta.main) await startDoctmcpServer();

async function startDoctmcpServer(): Promise<void> {
  let publicMcpFetch: (request: Request) => Promise<Response> = async () =>
    new Response("Public MCP is not configured.", { status: 503 });
  let publicHttpFetch = (
    request: Request,
    _context?: import("./gateway").BridgeGatewayHttpContext,
  ): Promise<Response> => publicMcpFetch(request);
  const runtime = createDoctmcpServerRuntime({
    host: process.env.BIND_HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 3000),
    httpHandler: (request, context) => publicHttpFetch(request, context),
  });
  const publicPairing = createPublicPairingEndpoint({
    pairingService: runtime.pairingService,
    channelCoordinator: runtime.pairingChannelCoordinator,
    abuseGuard: runtime.pairingAbuseGuard,
    trustedProxyAddresses: (process.env.TRUSTED_PROXY_ADDRESSES ?? "")
      .split(",")
      .map((address) => address.trim())
      .filter((address) => address.length > 0),
  });
  publicHttpFetch = async (request, context) => {
    const pairingResponse = await publicPairing.fetch(request, context);
    return pairingResponse.status === 404
      ? publicMcpFetch(request)
      : pairingResponse;
  };
  let publicMcp: ReturnType<typeof createPublicMcpEndpoint> | undefined;

  try {
    const publicMcpUrlValue = process.env.PUBLIC_MCP_URL;
    const issuer = process.env.OIDC_ISSUER;
    const audience = process.env.OIDC_AUDIENCE;
    const configuration = [publicMcpUrlValue, issuer, audience];
    if (configuration.every((value) => value === undefined || value === "")) {
      console.warn(
        "Public MCP is disabled. Configure PUBLIC_MCP_URL, OIDC_ISSUER and OIDC_AUDIENCE to enable it.",
      );
    } else {
      if (configuration.some((value) => !value)) {
        throw new Error(
          "PUBLIC_MCP_URL, OIDC_ISSUER and OIDC_AUDIENCE must all be configured.",
        );
      }
      const mcpUrl = new URL(publicMcpUrlValue as string);
      if (audience !== mcpUrl.href) {
        throw new Error("OIDC_AUDIENCE phải trùng chính xác PUBLIC_MCP_URL.");
      }
      const verifier = await createOidcAccessTokenVerifier({
        issuer: issuer as string,
        audience: audience as string,
      });
      publicMcp = createPublicMcpEndpoint({
        deviceRouter: runtime.deviceRouter,
        pairingCredentialCompletionService:
          runtime.pairingCredentialCompletionService,
        pairingChannelCoordinator: runtime.pairingChannelCoordinator,
        verifier,
        oauthMetadata: verifier.oauthMetadata,
        mcpUrl,
        audit: (event) =>
          console.info(JSON.stringify({ event: "mcp.tool", ...event })),
      });
      publicMcpFetch = publicMcp.fetch;
    }
  } catch (error) {
    await runtime.stop();
    throw error;
  }

  console.log(`${SERVER_COMPONENT}: listening on ${runtime.gateway.url}`);
  if (publicMcp) {
    console.log(`Public MCP: ${process.env.PUBLIC_MCP_URL}`);
  }

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await stopDoctmcpServer(publicMcp, runtime);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}
