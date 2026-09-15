import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { BridgeServerTransport } from "../../agent/src/bridge-server-transport";
import { createLocalMcpRuntime } from "../../agent/src/local-mcp-runtime";
import { WorkspaceRegistry } from "../../agent/src/workspace";
import { BridgeClientTransport } from "./bridge-client-transport";
import {
  DeviceCredentialService,
  InMemoryDeviceCredentialRepository,
} from "./device-credential";
import { InMemoryDeviceRepository } from "./device-repository";
import {
  type BridgeGateway,
  type BridgeGatewaySession,
  createBridgeGateway,
} from "./gateway";

const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_SECRET = "m3-authenticated-device-secret";

function textFromResult(result: unknown): string {
  if (
    typeof result !== "object" ||
    result === null ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    throw new Error("Expected MCP result content");
  }
  const first = result.content[0];
  if (
    typeof first !== "object" ||
    first === null ||
    !("type" in first) ||
    first.type !== "text" ||
    !("text" in first) ||
    typeof first.text !== "string"
  ) {
    throw new Error("Expected text MCP content");
  }
  return first.text;
}

describe("M3 authenticated bridge acceptance", () => {
  const roots: string[] = [];
  const gateways: BridgeGateway[] = [];
  const localTransports: BridgeServerTransport[] = [];
  const publicTransports: BridgeClientTransport[] = [];
  const runtimes: Array<ReturnType<typeof createLocalMcpRuntime>> = [];
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await Promise.allSettled(
      publicTransports.splice(0).map((transport) => transport.close()),
    );
    await Promise.allSettled(
      localTransports.splice(0).map((transport) => transport.close()),
    );
    await Promise.allSettled(
      runtimes.splice(0).map((runtime) => runtime.close()),
    );
    await Promise.allSettled(
      gateways.splice(0).map((gateway) => gateway.stop()),
    );
    await Promise.allSettled(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function createCredentialFixture() {
    const devices = new InMemoryDeviceRepository({
      generateDeviceId: () => DEVICE_ID,
    });
    const device = await devices.create({
      ownerId: "owner-a",
      deviceName: "M3 authenticated device",
      metadata: { platform: "darwin-arm64" },
    });
    const credentials = new InMemoryDeviceCredentialRepository();
    const credentialService = new DeviceCredentialService({
      repository: credentials,
      deviceRepository: devices,
      generateCredentialId: () => CREDENTIAL_ID,
      generateSecret: () => DEVICE_SECRET,
    });
    const issued = await credentialService.issue(device.deviceId);
    return { device, credentialService, issued };
  }

  test("authenticates device identity before exposing session and preserves MCP flow", async () => {
    const { device, credentialService, issued } =
      await createCredentialFixture();
    const root = await mkdtemp(join(tmpdir(), "doctmcp-m3-auth-"));
    roots.push(root);
    const registry = await WorkspaceRegistry.create([
      {
        id: "project",
        name: "M3 auth project",
        root,
        capabilities: {
          read: true,
          write: true,
          delete: true,
          execute: true,
        },
      },
    ]);

    let resolveSession: ((session: BridgeGatewaySession) => void) | undefined;
    const sessionReady = new Promise<BridgeGatewaySession>((resolve) => {
      resolveSession = resolve;
    });
    const gateway = createBridgeGateway({
      port: 0,
      idleTimeoutMs: 0,
      authenticateDevice: async (deviceId, credential) =>
        (await credentialService.verify(deviceId, credential)).identity,
      onSession: (session) => resolveSession?.(session),
    });
    gateways.push(gateway);

    const runtime = createLocalMcpRuntime(registry);
    runtimes.push(runtime);
    const localTransport = new BridgeServerTransport({
      url: gateway.url,
      sessionId: "m3-auth-session",
      auth: {
        deviceId: device.deviceId,
        credential: issued.secret,
      },
    });
    localTransports.push(localTransport);

    const localConnected = runtime.connect(localTransport);
    const session = await sessionReady;
    await localConnected;

    expect(session.identity).toEqual({
      ownerId: device.ownerId,
      deviceId: device.deviceId,
    });
    expect(session.id).toBe("m3-auth-session");
    expect(session.state).toBe("ready");

    const publicTransport = new BridgeClientTransport(session);
    publicTransports.push(publicTransport);
    const client = new Client({ name: "doctmcp-m3-auth", version: "0.1.0" });
    clients.push(client);
    await client.connect(publicTransport);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain("system");
    const system = await client.callTool({
      name: "system",
      arguments: { action: "info" },
    });
    expect(system.isError).toBeFalsy();
    expect(textFromResult(system)).toContain("bun");
  });

  test("revoked credential cannot create a ready bridge session", async () => {
    const { device, credentialService, issued } =
      await createCredentialFixture();
    await credentialService.revoke(device.deviceId);

    let exposed = false;
    const gateway = createBridgeGateway({
      port: 0,
      authenticateDevice: async (deviceId, credential) =>
        (await credentialService.verify(deviceId, credential)).identity,
      onSession: () => {
        exposed = true;
      },
    });
    gateways.push(gateway);

    const localTransport = new BridgeServerTransport({
      url: gateway.url,
      auth: {
        deviceId: device.deviceId,
        credential: issued.secret,
      },
    });
    localTransports.push(localTransport);

    await expect(localTransport.start()).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message: "Device authentication failed",
    });
    expect(exposed).toBe(false);
    expect(gateway.sessionCount).toBe(0);
  });
});
