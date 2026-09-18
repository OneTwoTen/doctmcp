import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  createLocalMcpRuntime,
  FileDeviceCredentialProvider,
  LocalBridgeReconnectController,
  LocalPairingClient,
  WorkspaceRegistry,
} from "../../agent/src/index";
import type { PublicMcpEndpoint } from "./public-mcp-endpoint";
import { createPublicMcpEndpoint } from "./public-mcp-endpoint";
import { createPublicPairingEndpoint } from "./public-pairing-endpoint";
import {
  createDoctmcpServerRuntime,
  type DoctmcpServerRuntime,
} from "./server-runtime";

const OWNER_ID = "oidc:v1:7Wkz5-H0vJXhHAHizmjCqO4eTShO_wzXq1G3Xk79QQ";
const MCP_URL = new URL("https://api.example.test/mcp");
const OAUTH_METADATA: OAuthMetadata = {
  issuer: "https://login.example.test/",
  authorization_endpoint: "https://login.example.test/authorize",
  token_endpoint: "https://login.example.test/token",
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
};

function verifier(ownerId: string): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token) {
      if (token !== "valid-owner-token") {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "invalid");
      }
      return {
        token,
        clientId: "chatgpt-test-client",
        scopes: ["mcp"],
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        extra: { ownerId },
      };
    },
  };
}

async function waitFor<T>(get: () => T | null | undefined): Promise<T> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const value = get();
    if (value !== null && value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for M5 acceptance state");
}

describe("M5 local CLI and ChatGPT pairing acceptance", () => {
  const runtimes: DoctmcpServerRuntime[] = [];
  const publicEndpoints: PublicMcpEndpoint[] = [];
  const clients: Client[] = [];
  const roots: string[] = [];
  const localRuntimes: Awaited<ReturnType<typeof createLocalMcpRuntime>>[] = [];
  const controllers: LocalBridgeReconnectController[] = [];
  const pairingClients: LocalPairingClient[] = [];

  afterEach(async () => {
    await Promise.allSettled([
      ...controllers.splice(0).map((controller) => controller.stop()),
      ...pairingClients.splice(0).map((client) => client.close()),
      ...clients.splice(0).map((client) => client.close()),
      ...publicEndpoints.splice(0).map((endpoint) => endpoint.close()),
      ...localRuntimes.splice(0).map((runtime) => runtime.close()),
      ...runtimes.splice(0).map((runtime) => runtime.stop()),
    ]);
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  test("pairs through outbound WebSocket, persists before ACK, then routes MCP to the configured workspace", async () => {
    let publicMcpFetch: (request: Request) => Promise<Response> = async () =>
      new Response("Public MCP is not ready.", { status: 503 });
    let publicPairingFetch: (
      request: Request,
      context?: { readonly remoteAddress: string | null },
    ) => Promise<Response> = async () =>
      new Response("Not found", { status: 404 });
    const server = createDoctmcpServerRuntime({
      host: "127.0.0.1",
      port: 0,
      idleTimeoutMs: 0,
      httpHandler: async (request, context) => {
        const pairingResponse = await publicPairingFetch(request, context);
        return pairingResponse.status === 404
          ? publicMcpFetch(request)
          : pairingResponse;
      },
    });
    runtimes.push(server);
    const publicPairing = createPublicPairingEndpoint({
      pairingService: server.pairingService,
      channelCoordinator: server.pairingChannelCoordinator,
      abuseGuard: server.pairingAbuseGuard,
    });
    publicPairingFetch = publicPairing.fetch;

    const audit: unknown[] = [];
    const publicMcp = createPublicMcpEndpoint({
      deviceRouter: server.deviceRouter,
      pairingCredentialCompletionService:
        server.pairingCredentialCompletionService,
      pairingChannelCoordinator: server.pairingChannelCoordinator,
      verifier: verifier(OWNER_ID),
      oauthMetadata: OAUTH_METADATA,
      mcpUrl: MCP_URL,
      audit: (event) => {
        audit.push(event);
      },
    });
    publicEndpoints.push(publicMcp);
    publicMcpFetch = publicMcp.fetch;

    const credentialRoot = await mkdtemp(join(tmpdir(), "doctmcp-m5-"));
    roots.push(credentialRoot);
    const credentialPath = join(credentialRoot, "secrets", "credential.json");
    const credentialProvider = new FileDeviceCredentialProvider(credentialPath);
    const pairingCodeShown: string[] = [];
    const pairingClient = new LocalPairingClient({
      serverUrl: server.gateway.url
        .replace(/^ws:/u, "http:")
        .replace(/\/bridge$/u, ""),
      deviceName: "M5 workstation",
      credentialProvider,
      onPairingCode: (code) => pairingCodeShown.push(code),
    });
    pairingClients.push(pairingClient);
    await pairingClient.start();
    expect(pairingCodeShown).toHaveLength(1);
    const pairingCode = pairingCodeShown[0];
    expect(pairingCode).toBeString();

    const client = new Client({
      name: "doctmcp-m5-acceptance",
      version: "0.1.0",
    });
    clients.push(client);
    const mcpHttpUrl = new URL(
      server.gateway.url
        .replace(/^ws:/u, "http:")
        .replace(/\/bridge$/u, "/mcp"),
    );
    await client.connect(
      new StreamableHTTPClientTransport(mcpHttpUrl, {
        requestInit: {
          headers: { authorization: "Bearer valid-owner-token" },
        },
      }),
    );
    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name)).toContain("devices_pair");
    expect(tools.tools.map(({ name }) => name)).toContain("devices_list");

    const credentialWait = pairingClient.waitForCredential();
    const pairResultPromise = client.callTool({
      name: "devices_pair",
      arguments: { pairingCode, deviceName: "M5 workstation" },
    });
    const localCredential = await credentialWait;
    const pairResult = await pairResultPromise;
    expect(pairResult.isError).toBeFalsy();
    expect(pairResult.structuredContent).toMatchObject({
      deviceId: localCredential.deviceId,
      deviceName: "M5 workstation",
      status: "paired",
    });
    expect(JSON.stringify(pairResult)).not.toContain(
      localCredential.credential,
    );
    expect(JSON.stringify(audit)).not.toContain(localCredential.credential);
    expect(JSON.stringify(audit)).not.toContain(pairingCode);
    expect(await credentialProvider.load()).toEqual(localCredential);
    expect(await readFile(credentialPath, "utf8")).not.toContain(pairingCode);

    const workspaceRoot = await mkdtemp(join(tmpdir(), "doctmcp-workspace-"));
    roots.push(workspaceRoot);
    await writeFile(join(workspaceRoot, "note.txt"), "private local note\n");
    const workspaces = await WorkspaceRegistry.create([
      {
        id: "work",
        name: "Work files",
        root: workspaceRoot,
        capabilities: { read: true },
      },
    ]);
    const localRuntime = createLocalMcpRuntime(workspaces);
    localRuntimes.push(localRuntime);
    const controller = new LocalBridgeReconnectController({
      url: server.gateway.url,
      runtime: localRuntime,
      credentialProvider,
      backoffPolicy: {
        minDelayMs: 5,
        maxDelayMs: 20,
        factor: 2,
        jitterRatio: 0,
        stableReadyMs: 0,
      },
    });
    controllers.push(controller);
    controller.start();
    await waitFor(() =>
      server.deviceSessionRegistry.getActive(localCredential.deviceId),
    );

    const deviceList = await client.callTool({ name: "devices_list" });
    expect(deviceList.structuredContent).toMatchObject({
      devices: [
        {
          deviceId: localCredential.deviceId,
          deviceName: "M5 workstation",
          status: "online",
        },
      ],
    });
    const prefix = `d_${localCredential.deviceId.replaceAll("-", "")}__`;
    const read = await client.callTool({
      name: `${prefix}filesystem.read`,
      arguments: { action: "read", workspace: "work", path: "note.txt" },
    });
    expect(read.isError).toBeFalsy();
    expect(JSON.stringify(read)).toContain("private local note");
    const deniedWrite = await client.callTool({
      name: `${prefix}filesystem.write`,
      arguments: {
        action: "write",
        workspace: "work",
        path: "forbidden.txt",
        content: "denied",
      },
    });
    expect(deniedWrite.isError).toBe(true);
    expect(await Bun.file(join(workspaceRoot, "forbidden.txt")).exists()).toBe(
      false,
    );
  });
});
