import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { BridgeServerTransport } from "../../agent/src/bridge-server-transport";
import { InMemoryDeviceCredentialProvider } from "../../agent/src/device-credential-provider";
import { LocalBridgeReconnectController } from "../../agent/src/local-bridge-reconnect";
import { createLocalMcpRuntime } from "../../agent/src/local-mcp-runtime";
import { WorkspaceRegistry } from "../../agent/src/workspace";
import { BridgeClientTransport } from "./bridge-client-transport";
import {
  createDoctmcpServerRuntime,
  type DoctmcpServerRuntime,
} from "./server-runtime";

function waitFor<T>(value: () => T | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for M3 acceptance condition")),
      5_000,
    );
    const check = (): void => {
      const result = value();
      if (result === undefined) {
        setTimeout(check, 5);
        return;
      }
      clearTimeout(timeout);
      resolve(result);
    };
    check();
  });
}

describe("M3 vertical acceptance", () => {
  const serverRuntimes: DoctmcpServerRuntime[] = [];
  const localRuntimes: Array<ReturnType<typeof createLocalMcpRuntime>> = [];
  const rejectedAuthTransports: BridgeServerTransport[] = [];
  const controllers: LocalBridgeReconnectController[] = [];
  const publicTransports: BridgeClientTransport[] = [];
  const clients: Client[] = [];
  const workspaceRoots: string[] = [];

  afterEach(async () => {
    const cleanupFailures: unknown[] = [];
    const settleCleanup = async (operations: Promise<unknown>[]) => {
      const outcomes = await Promise.allSettled(operations);
      cleanupFailures.push(
        ...outcomes
          .filter((outcome) => outcome.status === "rejected")
          .map((outcome) => outcome.reason),
      );
    };
    await settleCleanup(clients.splice(0).map((client) => client.close()));
    await settleCleanup(
      publicTransports.splice(0).map((transport) => transport.close()),
    );
    await settleCleanup(
      rejectedAuthTransports.splice(0).map((transport) => transport.close()),
    );
    await settleCleanup(
      controllers.splice(0).map((controller) => controller.stop()),
    );
    await settleCleanup(
      localRuntimes.splice(0).map((runtime) => runtime.close()),
    );
    await settleCleanup(
      serverRuntimes.splice(0).map((runtime) => runtime.stop()),
    );
    await settleCleanup(
      workspaceRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true })),
    );
    expect(cleanupFailures).toEqual([]);
  });

  async function createPairedLocal(
    server: DoctmcpServerRuntime,
    label: "alpha" | "beta",
  ) {
    const pairing = await server.pairingService.createPairingSession({
      localCorrelationId: crypto.randomUUID(),
    });
    const completed =
      await server.pairingCredentialCompletionService.claimAndIssue(
        pairing.pairingCode,
        {
          ownerId: "owner-m3-acceptance",
          deviceName: "Same device name",
          metadata: { platform: `test-${label}` },
        },
      );
    const root = await mkdtemp(join(tmpdir(), `doctmcp-m3-${label}-`));
    workspaceRoots.push(root);
    const workspaces = await WorkspaceRegistry.create([
      {
        id: `workspace-${label}`,
        name: `Workspace ${label}`,
        root,
        capabilities: { read: true },
      },
    ]);
    const localRuntime = createLocalMcpRuntime(workspaces);
    localRuntimes.push(localRuntime);
    const credentialProvider = new InMemoryDeviceCredentialProvider({
      deviceId: completed.device.deviceId,
      credential: completed.secret,
    });
    const controller = new LocalBridgeReconnectController({
      url: server.gateway.url,
      runtime: localRuntime,
      credentialProvider,
      backoffPolicy: {
        minDelayMs: 10,
        maxDelayMs: 50,
        factor: 2,
        jitterRatio: 0,
        stableReadyMs: 100,
      },
      random: () => 0.5,
    });
    controllers.push(controller);

    return { completed, credentialProvider, controller };
  }

  async function connectMcpClient(
    server: DoctmcpServerRuntime,
    deviceId: string,
  ) {
    const routed = await server.deviceRouter.resolve(
      "owner-m3-acceptance",
      deviceId,
    );
    const transport = new BridgeClientTransport(routed.session);
    publicTransports.push(transport);
    const client = new Client({
      name: "doctmcp-m3-acceptance",
      version: "0.1.0",
    });
    clients.push(client);
    await client.connect(transport);
    return { client, routed };
  }

  async function expectLocalIdentity(client: Client, workspaceId: string) {
    expect(client.getServerVersion()).toMatchObject({
      name: "doctmcp-agent",
      version: "0.1.0",
    });
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(6);
    expect(listed.tools.map(({ name }) => name)).toContain("workspace");

    const system = await client.callTool({
      name: "system",
      arguments: { action: "info" },
    });
    expect(system.isError).toBeFalsy();
    expect(system.structuredContent).toMatchObject({
      runtime: { name: "bun" },
    });

    const workspace = await client.callTool({
      name: "workspace",
      arguments: { action: "list" },
    });
    expect(workspace.isError).toBeFalsy();
    expect(workspace.structuredContent).toMatchObject({
      workspaces: [{ id: workspaceId }],
    });
  }

  test("pairs two same-named devices, routes MCP to each exact runtime, and reconnects without changing identity", async () => {
    const server = createDoctmcpServerRuntime({
      port: 0,
      idleTimeoutMs: 0,
      heartbeatIntervalMs: 20,
      heartbeatTimeoutMs: 200,
    });
    serverRuntimes.push(server);

    const alpha = await createPairedLocal(server, "alpha");
    const beta = await createPairedLocal(server, "beta");

    const crossDeviceCredential = new BridgeServerTransport({
      url: server.gateway.url,
      auth: {
        deviceId: beta.completed.device.deviceId,
        credential: alpha.completed.secret,
      },
    });
    rejectedAuthTransports.push(crossDeviceCredential);
    await expect(crossDeviceCredential.start()).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
    expect(
      server.deviceSessionRegistry.getActive(beta.completed.device.deviceId),
    ).toBeNull();

    alpha.controller.start();
    beta.controller.start();

    const alphaSession = await waitFor(() => {
      if (alpha.controller.snapshot.state !== "ready") return undefined;
      return (
        server.deviceSessionRegistry.getActive(
          alpha.completed.device.deviceId,
        ) ?? undefined
      );
    });
    const betaSession = await waitFor(() => {
      if (beta.controller.snapshot.state !== "ready") return undefined;
      return (
        server.deviceSessionRegistry.getActive(
          beta.completed.device.deviceId,
        ) ?? undefined
      );
    });

    expect(alpha.completed.device.deviceId).not.toBe(
      beta.completed.device.deviceId,
    );
    expect(alpha.completed.device.deviceName).toBe(
      beta.completed.device.deviceName,
    );
    expect(server.getDeviceStatus(alpha.completed.device.deviceId).status).toBe(
      "online",
    );
    expect(server.getDeviceStatus(beta.completed.device.deviceId).status).toBe(
      "online",
    );

    const devices = await server.deviceRouter.listDevices(
      "owner-m3-acceptance",
    );
    expect(devices.map(({ deviceId }) => deviceId)).toEqual([
      alpha.completed.device.deviceId,
      beta.completed.device.deviceId,
    ]);
    expect(devices.every(({ status }) => status === "online")).toBe(true);

    const routedAlpha = await connectMcpClient(
      server,
      alpha.completed.device.deviceId,
    );
    const routedBeta = await connectMcpClient(
      server,
      beta.completed.device.deviceId,
    );
    expect(routedAlpha.routed.session.identity?.deviceId).toBe(
      alpha.completed.device.deviceId,
    );
    expect(routedAlpha.routed.session).toBe(alphaSession.session);
    expect(routedBeta.routed.session.identity?.deviceId).toBe(
      beta.completed.device.deviceId,
    );
    expect(routedBeta.routed.session).toBe(betaSession.session);
    await expectLocalIdentity(routedAlpha.client, "workspace-alpha");
    await expectLocalIdentity(routedBeta.client, "workspace-beta");

    await alphaSession.session.close(
      "TIMEOUT",
      "M3_ACCEPTANCE_TRANSIENT_CLOSE",
    );
    const reconnectedAlpha = await waitFor(() => {
      if (alpha.controller.snapshot.state !== "ready") return undefined;
      const current = server.deviceSessionRegistry.getActive(
        alpha.completed.device.deviceId,
      );
      return current && current.session.id !== alphaSession.session.id
        ? current
        : undefined;
    });
    expect(reconnectedAlpha.session.id).not.toBe(alphaSession.session.id);
    expect(reconnectedAlpha.session.identity?.deviceId).toBe(
      alpha.completed.device.deviceId,
    );
    expect(await alpha.credentialProvider.load()).toEqual({
      deviceId: alpha.completed.device.deviceId,
      credential: alpha.completed.secret,
    });
    const routedAfterReconnect = await connectMcpClient(
      server,
      alpha.completed.device.deviceId,
    );
    await expectLocalIdentity(routedAfterReconnect.client, "workspace-alpha");

    await expect(
      server.deviceRouter.resolve(
        "another-owner",
        alpha.completed.device.deviceId,
      ),
    ).rejects.toMatchObject({ code: "DEVICE_NOT_FOUND" });
    await expect(
      server.deviceRouter.resolve(
        "owner-m3-acceptance",
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      ),
    ).rejects.toMatchObject({ code: "DEVICE_NOT_FOUND" });

    await beta.controller.stop();
    await waitFor(() =>
      server.deviceSessionRegistry.getActive(beta.completed.device.deviceId)
        ? undefined
        : true,
    );
    await expect(
      server.deviceRouter.resolve(
        "owner-m3-acceptance",
        beta.completed.device.deviceId,
      ),
    ).rejects.toMatchObject({ code: "DEVICE_OFFLINE" });
  });
});
