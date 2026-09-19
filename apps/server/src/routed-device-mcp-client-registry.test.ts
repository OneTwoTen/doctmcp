import { afterEach, describe, expect, test } from "bun:test";
import { BridgeServerTransport } from "../../agent/src/bridge-server-transport";
import { createLocalMcpRuntime } from "../../agent/src/local-mcp-runtime";
import type { LocalMcpServerInstance } from "../../agent/src/server";
import { WorkspaceRegistry } from "../../agent/src/workspace";
import { RoutedDeviceMcpClientRegistry } from "./routed-device-mcp-client-registry";
import {
  createDoctmcpServerRuntime,
  type DoctmcpServerRuntime,
} from "./server-runtime";

function waitFor<T>(value: () => T | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for M4 test condition")),
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

describe("RoutedDeviceMcpClientRegistry", () => {
  const serverRuntimes: DoctmcpServerRuntime[] = [];
  const localRuntimes: LocalMcpServerInstance[] = [];
  const transports: BridgeServerTransport[] = [];
  const registries: RoutedDeviceMcpClientRegistry[] = [];

  afterEach(async () => {
    const cleanup = await Promise.allSettled([
      ...registries.splice(0).map((registry) => registry.close()),
      ...transports.splice(0).map((transport) => transport.close()),
      ...localRuntimes.splice(0).map((runtime) => runtime.close()),
      ...serverRuntimes.splice(0).map((runtime) => runtime.stop()),
    ]);
    expect(cleanup.filter(({ status }) => status === "rejected")).toEqual([]);
  });

  async function pairAndConnect(
    server: DoctmcpServerRuntime,
    ownerId: string,
    label: string,
  ) {
    const pairing = await server.pairingService.createPairingSession({
      localCorrelationId: crypto.randomUUID(),
    });
    const device =
      await server.pairingCredentialCompletionService.claimAndIssue(
        pairing.pairingCode,
        {
          ownerId,
          deviceName: "Same device name",
          metadata: { platform: "test" },
        },
      );
    const workspace = await WorkspaceRegistry.create([
      {
        id: label,
        name: label,
        root: process.cwd(),
        capabilities: { read: true },
      },
    ]);
    const localRuntime = createLocalMcpRuntime(workspace);
    localRuntimes.push(localRuntime);
    const transport = new BridgeServerTransport({
      url: server.gateway.url,
      auth: {
        deviceId: device.device.deviceId,
        credential: device.secret,
      },
    });
    transports.push(transport);
    const connected = localRuntime.connect(transport);
    await waitFor(
      () =>
        server.deviceSessionRegistry.getActive(device.device.deviceId) ??
        undefined,
    );
    await connected;
    return { device };
  }

  test("reuses one initialized MCP client per bridge session and routes only to its owner/device", async () => {
    const server = createDoctmcpServerRuntime({ port: 0, idleTimeoutMs: 0 });
    serverRuntimes.push(server);
    const alpha = await pairAndConnect(server, "owner-m4", "alpha");
    const beta = await pairAndConnect(server, "owner-m4", "beta");
    const registry = new RoutedDeviceMcpClientRegistry(server.deviceRouter);
    registries.push(registry);

    const [alphaTools, alphaToolsConcurrent] = await Promise.all([
      registry.listTools("owner-m4", alpha.device.device.deviceId),
      registry.listTools("owner-m4", alpha.device.device.deviceId),
    ]);
    const betaTools = await registry.listTools(
      "owner-m4",
      beta.device.device.deviceId,
    );
    expect(alphaTools.tools).toHaveLength(6);
    expect(alphaToolsConcurrent.tools).toHaveLength(6);
    expect(betaTools.tools.map(({ name }) => name)).toEqual(
      alphaTools.tools.map(({ name }) => name),
    );
    expect(
      registry.getCachedTools("owner-m4", beta.device.device.deviceId)?.tools,
    ).toHaveLength(6);
    expect(
      registry.getCachedTools("other-owner", beta.device.device.deviceId),
    ).toBeUndefined();

    const alphaWorkspace = await registry.callTool(
      "owner-m4",
      alpha.device.device.deviceId,
      "workspace",
      { action: "list" },
    );
    const alphaAgain = await registry.callTool(
      "owner-m4",
      alpha.device.device.deviceId,
      "system",
      { action: "info" },
    );
    expect(alphaWorkspace.isError).toBeFalsy();
    expect(alphaWorkspace.structuredContent).toMatchObject({
      workspaces: [{ id: "alpha" }],
    });
    expect(alphaAgain.isError).toBeFalsy();
    expect(alphaAgain.structuredContent).toMatchObject({
      runtime: { name: "bun" },
    });

    await expect(
      registry.callTool("other-owner", alpha.device.device.deviceId, "system", {
        action: "info",
      }),
    ).rejects.toMatchObject({ code: "DEVICE_NOT_FOUND" });

    const betaSession = server.deviceSessionRegistry.getActive(
      beta.device.device.deviceId,
    );
    expect(betaSession).not.toBeNull();
    await betaSession?.session.close("TIMEOUT", "M4_TEST_OFFLINE");
    expect(
      registry.getCachedTools("owner-m4", beta.device.device.deviceId)?.tools,
    ).toHaveLength(6);
    await expect(
      registry.callTool("owner-m4", beta.device.device.deviceId, "system", {
        action: "info",
      }),
    ).rejects.toMatchObject({ code: "DEVICE_OFFLINE" });
  });
});
