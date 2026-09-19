import { afterEach, describe, expect, test } from "bun:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  OAuthError,
  OAuthErrorCode,
  type OAuthMetadata,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { BridgeServerTransport } from "../../agent/src/bridge-server-transport";
import { createLocalMcpRuntime } from "../../agent/src/local-mcp-runtime";
import type { LocalMcpServerInstance } from "../../agent/src/server";
import { WorkspaceRegistry } from "../../agent/src/workspace";
import {
  DeviceRoutingError,
  type DeviceRoutingService,
} from "./device-routing";
import type { PublicMcpEndpoint } from "./public-mcp-endpoint";
import { createPublicMcpEndpoint } from "./public-mcp-endpoint";
import { RoutedDeviceMcpClientRegistry } from "./routed-device-mcp-client-registry";
import {
  createDoctmcpServerRuntime,
  type DoctmcpServerRuntime,
} from "./server-runtime";

const OWNER_ID = "oidc:v1:7Wkz5-H0vJXhHAHizmmjCqO4eTShO_wzXq1G3Xk79QQ";
const ISSUER = "https://login.example.test/";
const MCP_URL = new URL("https://api.example.test/mcp");
const OAUTH_METADATA: OAuthMetadata = {
  issuer: ISSUER,
  authorization_endpoint: "https://login.example.test/authorize",
  token_endpoint: "https://login.example.test/token",
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
};

function makeVerifier(ownerId: string): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token) {
      if (token === "invalid") {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "invalid");
      }
      return {
        token,
        clientId: "chatgpt-test-client",
        scopes: token === "missing-scope" ? [] : ["mcp"],
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        extra: { ownerId },
      };
    },
  };
}

function waitFor<T>(value: () => T | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for M4 public MCP test")),
      3_000,
    );
    const check = (): void => {
      const result = value();
      if (result === undefined) {
        setTimeout(check, 2);
        return;
      }
      clearTimeout(timeout);
      resolve(result);
    };
    check();
  });
}

describe("public MCP endpoint", () => {
  const publicEndpoints: PublicMcpEndpoint[] = [];
  const clients: Client[] = [];
  const transports: BridgeServerTransport[] = [];
  const localRuntimes: LocalMcpServerInstance[] = [];
  const serverRuntimes: DoctmcpServerRuntime[] = [];
  const clientRegistries: RoutedDeviceMcpClientRegistry[] = [];

  afterEach(async () => {
    const cleanups = await Promise.allSettled([
      ...clients.splice(0).map((client) => client.close()),
      ...publicEndpoints.splice(0).map((endpoint) => endpoint.close()),
      ...transports.splice(0).map((transport) => transport.close()),
      ...localRuntimes.splice(0).map((runtime) => runtime.close()),
      ...clientRegistries.splice(0).map((registry) => registry.close()),
      ...serverRuntimes.splice(0).map((runtime) => runtime.stop()),
    ]);
    expect(cleanups.filter(({ status }) => status === "rejected")).toEqual([]);
  });

  async function createConnectedDevice(
    server: DoctmcpServerRuntime,
    workspaceId: string,
  ) {
    const pairing = await server.pairingService.createPairingSession({
      localCorrelationId: crypto.randomUUID(),
    });
    const paired =
      await server.pairingCredentialCompletionService.claimAndIssue(
        pairing.pairingCode,
        {
          ownerId: OWNER_ID,
          deviceName: "Office workstation",
          metadata: { platform: "test" },
        },
      );
    const workspaces = await WorkspaceRegistry.create([
      {
        id: workspaceId,
        name: `${workspaceId} workspace`,
        root: process.cwd(),
        capabilities: { read: true },
      },
    ]);
    const localRuntime = createLocalMcpRuntime(workspaces);
    localRuntimes.push(localRuntime);
    const transport = new BridgeServerTransport({
      url: server.gateway.url,
      auth: {
        deviceId: paired.device.deviceId,
        credential: paired.secret,
      },
    });
    transports.push(transport);
    const connected = localRuntime.connect(transport);
    await waitFor(
      () =>
        server.deviceSessionRegistry.getActive(paired.device.deviceId) ??
        undefined,
    );
    await connected;
    return { paired, localRuntime };
  }

  test("requires an authenticated MCP scope and serves protected-resource metadata", async () => {
    const router = {
      listDevices: async () => [],
      resolve: async () => {
        throw new Error("not used");
      },
    } as unknown as DeviceRoutingService;
    const endpoint = createPublicMcpEndpoint({
      deviceRouter: router,
      verifier: makeVerifier(OWNER_ID),
      oauthMetadata: OAUTH_METADATA,
      mcpUrl: MCP_URL,
    });
    publicEndpoints.push(endpoint);

    const unauthorized = await endpoint.fetch(
      new Request(MCP_URL, { method: "POST", body: "{}" }),
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain(
      "resource_metadata=",
    );

    const insufficientScope = await endpoint.fetch(
      new Request(MCP_URL, {
        method: "POST",
        headers: { authorization: "Bearer missing-scope" },
        body: "{}",
      }),
    );
    expect(insufficientScope.status).toBe(403);
    expect(insufficientScope.headers.get("www-authenticate")).toContain(
      "insufficient_scope",
    );

    const invalidToken = await endpoint.fetch(
      new Request(MCP_URL, {
        method: "POST",
        headers: { authorization: "Bearer invalid" },
        body: "{}",
      }),
    );
    expect(invalidToken.status).toBe(401);

    const metadata = await endpoint.fetch(
      new Request(
        "https://api.example.test/.well-known/oauth-protected-resource/mcp",
      ),
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      resource: MCP_URL.href,
      authorization_servers: [ISSUER],
    });
  });

  test("devices_pair derives the owner, waits for credential ACK, and never returns the secret", async () => {
    let publicMcpFetch: (request: Request) => Promise<Response> = async () =>
      new Response("Public MCP test handler is not ready.", { status: 503 });
    const server = createDoctmcpServerRuntime({
      port: 0,
      idleTimeoutMs: 0,
      httpHandler: (request) => publicMcpFetch(request),
    });
    serverRuntimes.push(server);
    const pairing = await server.pairingService.createPairingSession();
    const proof = "B".repeat(43);
    await server.pairingChannelCoordinator.register(pairing.session, proof);

    let credentialFrame: Record<string, unknown> | undefined;
    let resolveCredentialFrame: (() => void) | undefined;
    const credentialReceived = new Promise<void>((resolve) => {
      resolveCredentialFrame = resolve;
    });
    const pairingSocket = {
      id: "m5-pairing-socket",
      async send(message: string) {
        const frame = JSON.parse(message) as Record<string, unknown>;
        if (frame.kind === "pairing.credential") {
          credentialFrame = frame;
          resolveCredentialFrame?.();
        }
      },
      close() {},
    };
    await server.pairingChannelCoordinator.attach(
      pairing.session.pairingSessionId,
      proof,
      pairingSocket,
    );

    const audit: unknown[] = [];
    const endpoint = createPublicMcpEndpoint({
      deviceRouter: server.deviceRouter,
      pairingCredentialCompletionService:
        server.pairingCredentialCompletionService,
      pairingChannelCoordinator: server.pairingChannelCoordinator,
      verifier: makeVerifier(OWNER_ID),
      oauthMetadata: OAUTH_METADATA,
      mcpUrl: MCP_URL,
      audit: (event) => {
        audit.push(event);
      },
    });
    publicEndpoints.push(endpoint);
    publicMcpFetch = endpoint.fetch;
    const client = new Client({ name: "doctmcp-m5-pairing", version: "0.1.0" });
    clients.push(client);
    const clientTransport = new StreamableHTTPClientTransport(
      new URL(
        server.gateway.url
          .replace(/^ws:/u, "http:")
          .replace(/\/bridge$/u, "/mcp"),
      ),
      {
        requestInit: { headers: { authorization: "Bearer valid-owner-token" } },
      },
    );
    await client.connect(clientTransport);

    const listed = await client.listTools();
    const pairTool = listed.tools.find(({ name }) => name === "devices_pair");
    expect(pairTool).toBeDefined();
    expect(pairTool?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });

    const resultPromise = client.callTool({
      name: "devices_pair",
      arguments: {
        pairingCode: pairing.pairingCode,
        deviceName: "M5 workstation",
      },
    });
    await credentialReceived;
    expect(credentialFrame).toBeDefined();
    const credential = credentialFrame?.credential;
    expect(credential).toBeString();
    await server.pairingChannelCoordinator.acknowledge(pairingSocket, {
      kind: "pairing.ack",
      pairingSessionId: pairing.session.pairingSessionId,
      deviceId: credentialFrame?.deviceId as string,
      credentialId: credentialFrame?.credentialId as string,
      version: credentialFrame?.version as number,
    });
    const result = await resultPromise;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      deviceName: "M5 workstation",
      status: "paired",
    });
    const resultText = JSON.stringify(result);
    expect(resultText).not.toContain(credential as string);
    expect(JSON.stringify(audit)).not.toContain(credential as string);
    expect(JSON.stringify(audit)).not.toContain(pairing.pairingCode);
  });

  test("lists and calls namespaced tools over Streamable HTTP through the exact local runtime", async () => {
    let publicMcpFetch: (request: Request) => Promise<Response> = async () =>
      new Response("Public MCP test handler is not ready.", { status: 503 });
    const server = createDoctmcpServerRuntime({
      port: 0,
      idleTimeoutMs: 0,
      httpHandler: (request) => publicMcpFetch(request),
    });
    serverRuntimes.push(server);
    const { paired, localRuntime } = await createConnectedDevice(
      server,
      "office-workspace",
    );
    const { paired: pairedSameName } = await createConnectedDevice(
      server,
      "home-workspace",
    );
    const audit: unknown[] = [];
    const endpoint = createPublicMcpEndpoint({
      deviceRouter: server.deviceRouter,
      verifier: makeVerifier(OWNER_ID),
      oauthMetadata: OAUTH_METADATA,
      mcpUrl: MCP_URL,
      audit: (event) => {
        audit.push(event);
      },
    });
    publicEndpoints.push(endpoint);
    publicMcpFetch = endpoint.fetch;
    const client = new Client({
      name: "doctmcp-m4-acceptance",
      version: "0.1.0",
    });
    clients.push(client);
    const mcpUrl = new URL(server.gateway.url.replace(/^ws:/u, "http:"));
    mcpUrl.pathname = "/mcp";
    const clientTransport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: {
        headers: { authorization: "Bearer valid-owner-token" },
      },
    });
    await client.connect(clientTransport);

    const listed = await client.listTools();
    const prefix = `d_${paired.device.deviceId.replaceAll("-", "")}__`;
    const sameNamePrefix = `d_${pairedSameName.device.deviceId.replaceAll("-", "")}__`;
    expect(listed.tools.map(({ name }) => name)).toContain(
      `${prefix}workspace`,
    );
    expect(listed.tools.map(({ name }) => name)).toContain(
      `${sameNamePrefix}workspace`,
    );
    expect(listed.tools.map(({ name }) => name)).toContain("devices_list");
    const publicWorkspaceTool = listed.tools.find(
      ({ name }) => name === `${prefix}workspace`,
    );
    expect(publicWorkspaceTool?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        workspaces: { type: "array" },
      },
    });

    const workspace = await client.callTool({
      name: `${prefix}workspace`,
      arguments: { action: "list" },
    });
    expect(workspace.isError).toBeFalsy();
    expect(workspace.structuredContent).toMatchObject({
      workspaces: [{ id: "office-workspace" }],
    });
    const sameNameWorkspace = await client.callTool({
      name: `${sameNamePrefix}workspace`,
      arguments: { action: "list" },
    });
    expect(sameNameWorkspace.structuredContent).toMatchObject({
      workspaces: [{ id: "home-workspace" }],
    });

    const devices = await client.callTool({ name: "devices_list" });
    expect(devices.structuredContent).toMatchObject({
      devices: [
        {
          deviceId: paired.device.deviceId,
          deviceName: "Office workstation",
          status: "online",
        },
        {
          deviceId: pairedSameName.device.deviceId,
          deviceName: "Office workstation",
          status: "online",
        },
      ],
    });
    const serializedAudit = JSON.stringify(audit);
    expect(serializedAudit).toContain('"toolName":"workspace"');
    expect(serializedAudit).not.toContain("action");
    expect(serializedAudit).not.toContain("office-workspace");

    const active = server.deviceSessionRegistry.getActive(
      paired.device.deviceId,
    );
    expect(active).not.toBeNull();
    await active?.session.close("TIMEOUT", "M4_TEST_OFFLINE");
    const offlineCall = await client.callTool({
      name: `${prefix}workspace`,
      arguments: { action: "list" },
    });
    expect(offlineCall.isError).toBe(true);
    expect(offlineCall.structuredContent).toEqual({
      error: { code: "DEVICE_OFFLINE" },
    });

    const replacementTransport = new BridgeServerTransport({
      url: server.gateway.url,
      auth: {
        deviceId: paired.device.deviceId,
        credential: paired.secret,
      },
    });
    transports.push(replacementTransport);
    const reconnected = localRuntime.connect(replacementTransport);
    await waitFor(
      () =>
        server.deviceSessionRegistry.getActive(paired.device.deviceId) ??
        undefined,
    );
    await reconnected;
    const afterReconnect = await client.callTool({
      name: `${prefix}workspace`,
      arguments: { action: "list" },
    });
    expect(afterReconnect.isError).toBeFalsy();
    expect(afterReconnect.structuredContent).toMatchObject({
      workspaces: [{ id: "office-workspace" }],
    });
  });
  test("keeps healthy devices usable when one ready device fails tool discovery", async () => {
    let publicMcpFetch: (request: Request) => Promise<Response> = async () =>
      new Response("Public MCP test handler is not ready.", { status: 503 });
    const server = createDoctmcpServerRuntime({
      port: 0,
      idleTimeoutMs: 0,
      httpHandler: (request) => publicMcpFetch(request),
    });
    serverRuntimes.push(server);
    const { paired: healthy } = await createConnectedDevice(
      server,
      "healthy-workspace",
    );
    const { paired: broken } = await createConnectedDevice(
      server,
      "broken-workspace",
    );

    class FaultInjectingRegistry extends RoutedDeviceMcpClientRegistry {
      constructor(
        router: DeviceRoutingService,
        readonly failingDeviceId: string,
      ) {
        super(router);
      }

      override async listTools(ownerId: string, deviceId: string) {
        if (deviceId === this.failingDeviceId) {
          throw new DeviceRoutingError(
            "ROUTING_UNAVAILABLE",
            "Injected listTools failure.",
          );
        }
        return super.listTools(ownerId, deviceId);
      }
    }

    const registry = new FaultInjectingRegistry(
      server.deviceRouter,
      broken.device.deviceId,
    );
    clientRegistries.push(registry);
    const endpoint = createPublicMcpEndpoint({
      deviceRouter: server.deviceRouter,
      clientRegistry: registry,
      verifier: makeVerifier(OWNER_ID),
      oauthMetadata: OAUTH_METADATA,
      mcpUrl: MCP_URL,
    });
    publicEndpoints.push(endpoint);
    publicMcpFetch = endpoint.fetch;

    const client = new Client({
      name: "doctmcp-m4-discovery-isolation",
      version: "0.1.0",
    });
    clients.push(client);
    const mcpUrl = new URL(server.gateway.url.replace(/^ws:/u, "http:"));
    mcpUrl.pathname = "/mcp";
    await client.connect(
      new StreamableHTTPClientTransport(mcpUrl, {
        requestInit: {
          headers: { authorization: "Bearer valid-owner-token" },
        },
      }),
    );

    const listed = await client.listTools();
    const healthyPrefix = `d_${healthy.device.deviceId.replaceAll("-", "")}__`;
    const brokenPrefix = `d_${broken.device.deviceId.replaceAll("-", "")}__`;
    expect(listed.tools.map(({ name }) => name)).toContain(
      `${healthyPrefix}workspace`,
    );
    expect(listed.tools.some(({ name }) => name.startsWith(brokenPrefix))).toBe(
      false,
    );
    expect(listed.tools.map(({ name }) => name)).toContain("devices_list");

    const devices = await client.callTool({ name: "devices_list" });
    expect(devices.isError).toBeFalsy();
    const deviceIds = (
      devices.structuredContent as {
        devices: Array<{ deviceId: string; status: string }>;
      }
    ).devices.map(({ deviceId }) => deviceId);
    expect(deviceIds).toContain(healthy.device.deviceId);
    expect(deviceIds).toContain(broken.device.deviceId);
  });
  test("rejects pairing at the device quota without consuming the pairing session", async () => {
    let publicMcpFetch: (request: Request) => Promise<Response> = async () =>
      new Response("Public MCP test handler is not ready.", { status: 503 });
    const server = createDoctmcpServerRuntime({
      port: 0,
      idleTimeoutMs: 0,
      httpHandler: (request) => publicMcpFetch(request),
    });
    serverRuntimes.push(server);
    for (let index = 0; index < 100; index += 1) {
      await server.deviceRepository.create({
        ownerId: OWNER_ID,
        deviceName: `Quota device ${index + 1}`,
        metadata: { platform: "test" },
      });
    }
    const pairing = await server.pairingService.createPairingSession();
    const endpoint = createPublicMcpEndpoint({
      deviceRouter: server.deviceRouter,
      pairingCredentialCompletionService:
        server.pairingCredentialCompletionService,
      pairingChannelCoordinator: server.pairingChannelCoordinator,
      verifier: makeVerifier(OWNER_ID),
      oauthMetadata: OAUTH_METADATA,
      mcpUrl: MCP_URL,
    });
    publicEndpoints.push(endpoint);
    publicMcpFetch = endpoint.fetch;
    const client = new Client({
      name: "doctmcp-device-quota",
      version: "0.1.0",
    });
    clients.push(client);
    const mcpUrl = new URL(server.gateway.url.replace(/^ws:/u, "http:"));
    mcpUrl.pathname = "/mcp";
    await client.connect(
      new StreamableHTTPClientTransport(mcpUrl, {
        requestInit: {
          headers: { authorization: "Bearer valid-owner-token" },
        },
      }),
    );

    const result = await client.callTool({
      name: "devices_pair",
      arguments: {
        pairingCode: pairing.pairingCode,
        deviceName: "Too many",
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { code: "ROUTING_UNAVAILABLE" },
    });
    await expect(
      server.pairingService.getPairingSession(pairing.session.pairingSessionId),
    ).resolves.toMatchObject({ state: "pending" });
    expect(await server.deviceRepository.listByOwnerId(OWNER_ID)).toHaveLength(
      100,
    );
  });
});
