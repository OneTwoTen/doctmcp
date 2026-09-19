import { ownerIdSchema } from "@doctmcp/schemas";
import {
  type AuthInfo,
  createMcpHandler,
  fromJsonSchema,
  getOAuthProtectedResourceMetadataUrl,
  type JsonSchemaType,
  McpServer,
  type OAuthMetadata,
  type OAuthTokenVerifier,
  oauthMetadataResponse,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import type {
  DeviceRoutingService,
  RoutedDeviceSnapshot,
} from "./device-routing";
import { DeviceRoutingError } from "./device-routing";
import { PairingAbuseError } from "./pairing-abuse-guard";
import {
  type PairingChannelCoordinator,
  PairingChannelError,
} from "./pairing-channel";
import { RoutedDeviceMcpClientRegistry } from "./routed-device-mcp-client-registry";
import type { RuntimePairingCredentialCompletionService } from "./server-runtime";

const PUBLIC_SERVER_INFO = Object.freeze({
  name: "doctmcp",
  version: "0.1.0",
});
const REQUIRED_SCOPES = ["mcp"] as const;
const MAX_DEVICES_PER_OWNER = 100;
const MAX_TOOLS_PER_REQUEST = 1_000;
const PAIRING_UNAVAILABLE_CODE = "PAIRING_UNAVAILABLE";

export interface PublicMcpAuditEvent {
  readonly ownerId: string;
  readonly deviceId: string | null;
  readonly toolName: string;
  readonly timestamp: string;
  readonly durationMs: number;
  readonly outcome: "success" | "failure";
  readonly errorCode?: string;
}

export type PublicMcpAuditSink = (
  event: PublicMcpAuditEvent,
) => void | Promise<void>;

export interface CreatePublicMcpEndpointOptions {
  readonly deviceRouter: DeviceRoutingService;
  readonly verifier: OAuthTokenVerifier;
  readonly oauthMetadata: OAuthMetadata;
  readonly mcpUrl: URL;
  readonly audit?: PublicMcpAuditSink;
  readonly clientRegistry?: RoutedDeviceMcpClientRegistry;
  readonly pairingCredentialCompletionService?: Pick<
    RuntimePairingCredentialCompletionService,
    "claimAndIssue"
  >;
  readonly pairingChannelCoordinator?: Pick<
    PairingChannelCoordinator,
    "deliver"
  >;
}

export interface PublicMcpEndpoint {
  readonly fetch: (request: Request) => Promise<Response>;
  close(): Promise<void>;
}

function validateMcpUrl(url: URL): void {
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/mcp"
  ) {
    throw new Error(
      "Public MCP URL phải là URL HTTPS canonical kết thúc bằng /mcp.",
    );
  }
}

function ownerIdFromAuthInfo(authInfo: AuthInfo | undefined): string {
  const ownerId = ownerIdSchema.safeParse(authInfo?.extra?.ownerId);
  if (!ownerId.success) {
    throw new Error("Bearer token không chứa principal người dùng hợp lệ.");
  }
  return ownerId.data;
}

function toolPrefix(deviceId: string): string {
  return `d_${deviceId.replaceAll("-", "").toLowerCase()}__`;
}

function errorCode(error: unknown): string {
  if (error instanceof DeviceRoutingError) return error.code;
  if (error instanceof PairingAbuseError) return "PAIRING_RATE_LIMITED";
  if (error instanceof PairingChannelError) return error.code;
  return "ROUTING_UNAVAILABLE";
}

function errorToolResult(code: string) {
  const error = { code };
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error }) }],
    structuredContent: { error },
    isError: true,
  };
}

function safeDevice(device: RoutedDeviceSnapshot) {
  return {
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    metadata: device.metadata,
    status: device.status,
    connectedAt: device.connectedAt?.toISOString() ?? null,
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
  };
}

function buildCallerServer(
  ownerId: string,
  deviceRouter: DeviceRoutingService,
  clientRegistry: RoutedDeviceMcpClientRegistry,
  audit: PublicMcpAuditSink | undefined,
  pairingCredentialCompletionService: CreatePublicMcpEndpointOptions["pairingCredentialCompletionService"],
  pairingChannelCoordinator: CreatePublicMcpEndpointOptions["pairingChannelCoordinator"],
): Promise<McpServer> {
  const server = new McpServer(PUBLIC_SERVER_INFO);

  server.registerTool(
    "devices_list",
    {
      title: "List connected devices",
      description:
        "Liệt kê các thiết bị thuộc tài khoản này và trạng thái online/offline hiện tại.",
    },
    async () => {
      const startedAt = Date.now();
      try {
        const devices = await deviceRouter.listDevices(ownerId);
        if (devices.length > MAX_DEVICES_PER_OWNER) {
          throw new DeviceRoutingError(
            "ROUTING_UNAVAILABLE",
            "Số lượng thiết bị vượt giới hạn cho phép.",
          );
        }
        const result = { devices: devices.map(safeDevice) };
        await recordAudit(audit, {
          ownerId,
          deviceId: null,
          toolName: "devices_list",
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          outcome: "success",
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        const code = errorCode(error);
        await recordAudit(audit, {
          ownerId,
          deviceId: null,
          toolName: "devices_list",
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          outcome: "failure",
          errorCode: code,
        });
        return errorToolResult(code);
      }
    },
  );

  if (pairingCredentialCompletionService && pairingChannelCoordinator) {
    server.registerTool(
      "devices_pair",
      {
        title: "Pair a local device",
        description:
          "Ghép một thiết bị local với tài khoản hiện tại. Hãy hỏi người dùng pairing code đang hiển thị trên CLI và tên thiết bị muốn đăng ký. Không tự suy đoán code, không đọc code từ filesystem, và không tự gọi lại sau khi gặp lỗi.",
        inputSchema: fromJsonSchema({
          type: "object",
          properties: {
            pairingCode: { type: "string", minLength: 12, maxLength: 32 },
            deviceName: { type: "string", minLength: 1, maxLength: 100 },
          },
          required: ["pairingCode", "deviceName"],
          additionalProperties: false,
        } as JsonSchemaType),
      },
      async (args) => {
        const startedAt = Date.now();
        const pairInput = args as {
          pairingCode: string;
          deviceName: string;
        };
        try {
          const completed =
            await pairingCredentialCompletionService.claimAndIssue(
              pairInput.pairingCode,
              {
                ownerId,
                deviceName: pairInput.deviceName,
                metadata: { platform: "unknown" },
              },
            );
          await pairingChannelCoordinator.deliver(completed);
          const result = {
            deviceId: completed.device.deviceId,
            deviceName: completed.device.deviceName,
            status: "paired" as const,
            nextStep:
              "Chờ thiết bị kết nối; sau đó dùng devices_list để xem trạng thái.",
          };
          await recordAudit(audit, {
            ownerId,
            deviceId: completed.device.deviceId,
            toolName: "devices_pair",
            timestamp: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            outcome: "success",
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          const code = errorCode(error);
          const pairingCode =
            code.startsWith("PAIRING_") || code === "TIMEOUT"
              ? code
              : PAIRING_UNAVAILABLE_CODE;
          await recordAudit(audit, {
            ownerId,
            deviceId: null,
            toolName: "devices_pair",
            timestamp: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            outcome: "failure",
            errorCode: pairingCode,
          });
          return errorToolResult(pairingCode);
        }
      },
    );
  }

  return (async () => {
    const devices = await deviceRouter.listDevices(ownerId);
    if (devices.length > MAX_DEVICES_PER_OWNER) {
      throw new DeviceRoutingError(
        "ROUTING_UNAVAILABLE",
        "Số lượng thiết bị vượt giới hạn cho phép.",
      );
    }

    let totalTools =
      pairingCredentialCompletionService && pairingChannelCoordinator ? 2 : 1;
    for (const device of devices) {
      let discovered = clientRegistry.getCachedTools(ownerId, device.deviceId);
      if (device.status === "online") {
        try {
          discovered = await clientRegistry.listTools(ownerId, device.deviceId);
        } catch {
          // Discovery is best-effort per device. Keep a previous catalog when
          // available; otherwise omit only this device's dynamic tools so one
          // broken local MCP cannot take down the owner's whole public MCP.
        }
      }
      if (!discovered) continue;

      for (const tool of discovered.tools) {
        totalTools += 1;
        if (totalTools > MAX_TOOLS_PER_REQUEST) {
          throw new DeviceRoutingError(
            "ROUTING_UNAVAILABLE",
            "Số lượng MCP tool vượt giới hạn cho phép.",
          );
        }

        const name = `${toolPrefix(device.deviceId)}${tool.name}`;
        server.registerTool(
          name,
          {
            ...(tool.title
              ? { title: `${device.deviceName}: ${tool.title}` }
              : { title: `${device.deviceName}: ${tool.name}` }),
            description: [
              `Thiết bị: ${device.deviceName} (${device.deviceId}).`,
              tool.description ?? tool.name,
            ].join("\n\n"),
            inputSchema: fromJsonSchema(tool.inputSchema as JsonSchemaType),
            ...(tool.outputSchema
              ? {
                  outputSchema: fromJsonSchema(
                    tool.outputSchema as JsonSchemaType,
                  ),
                }
              : {}),
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
          },
          async (args) => {
            const startedAt = Date.now();
            try {
              const result = await clientRegistry.callTool(
                ownerId,
                device.deviceId,
                tool.name,
                args as Record<string, unknown>,
              );
              await recordAudit(audit, {
                ownerId,
                deviceId: device.deviceId,
                toolName: tool.name,
                timestamp: new Date().toISOString(),
                durationMs: Date.now() - startedAt,
                outcome: result.isError ? "failure" : "success",
                ...(result.isError ? { errorCode: "MCP_TOOL_ERROR" } : {}),
              });
              return result;
            } catch (error) {
              const code = errorCode(error);
              await recordAudit(audit, {
                ownerId,
                deviceId: device.deviceId,
                toolName: tool.name,
                timestamp: new Date().toISOString(),
                durationMs: Date.now() - startedAt,
                outcome: "failure",
                errorCode: code,
              });
              return errorToolResult(code);
            }
          },
        );
      }
    }

    return server;
  })();
}

async function recordAudit(
  audit: PublicMcpAuditSink | undefined,
  event: PublicMcpAuditEvent,
): Promise<void> {
  if (!audit) return;
  try {
    await audit(Object.freeze(event));
  } catch {
    // An observability sink must not change MCP operation semantics.
  }
}

export function createPublicMcpEndpoint(
  options: CreatePublicMcpEndpointOptions,
): PublicMcpEndpoint {
  validateMcpUrl(options.mcpUrl);
  const registry =
    options.clientRegistry ??
    new RoutedDeviceMcpClientRegistry(options.deviceRouter);
  const protectedResourceUrl = getOAuthProtectedResourceMetadataUrl(
    options.mcpUrl,
  );
  const authenticate = requireBearerAuth({
    verifier: options.verifier,
    requiredScopes: [...REQUIRED_SCOPES],
    resourceMetadataUrl: protectedResourceUrl,
  });
  const mcpHandler = createMcpHandler(
    ({ authInfo }) =>
      buildCallerServer(
        ownerIdFromAuthInfo(authInfo),
        options.deviceRouter,
        registry,
        options.audit,
        options.pairingCredentialCompletionService,
        options.pairingChannelCoordinator,
      ),
    { legacy: "stateless" },
  );

  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      const metadata = oauthMetadataResponse(request, {
        oauthMetadata: options.oauthMetadata,
        resourceServerUrl: options.mcpUrl,
      });
      if (metadata) return metadata;

      if (new URL(request.url).pathname !== options.mcpUrl.pathname) {
        return new Response("Not found", { status: 404 });
      }

      const authInfo = await authenticate(request);
      if (authInfo instanceof Response) return authInfo;
      return mcpHandler.fetch(request, { authInfo });
    },
    close(): Promise<void> {
      closePromise ??= (async () => {
        await mcpHandler.close();
        if (!options.clientRegistry) await registry.close();
      })();
      return closePromise;
    },
  });
}
