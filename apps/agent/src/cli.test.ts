import { describe, expect, test } from "bun:test";
import {
  type CliPairingClient,
  type CliReconnectController,
  type CliRuntime,
  runConnectCli,
} from "./cli";
import type { AgentConfig } from "./cli-config";
import type {
  DeviceCredentialProvider,
  LocalDeviceCredential,
} from "./device-credential-provider";
import { WorkspaceRegistry } from "./workspace";

const DEVICE_ID = "a9dc7bd6-384c-44ca-a212-bcdfa4a62da3";
const CREDENTIAL = "A".repeat(43);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function createConfig(): Promise<AgentConfig> {
  const registry = await WorkspaceRegistry.create([
    {
      id: "work",
      name: "Work",
      root: process.cwd(),
      capabilities: { read: true },
    },
  ]);
  return {
    serverUrl: "https://api.example.test",
    deviceName: "Workstation",
    credentialPath: "unused",
    workspaces: registry.list(),
    workspaceRegistry: registry,
  };
}

async function waitFor(get: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (get()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for CLI lifecycle");
}

describe("runConnectCli", () => {
  test("pairs first, displays code only after attach, then starts authenticated reconnect", async () => {
    const events: string[] = [];
    const output: string[] = [];
    const shutdown = deferred();
    let saved: LocalDeviceCredential | null = null;
    const provider: DeviceCredentialProvider = {
      async load(): Promise<LocalDeviceCredential | null> {
        return saved;
      },
      async replace(credential) {
        saved = credential;
        events.push("credential.saved");
      },
    };
    const runtime: CliRuntime = {
      async connect() {},
      async close() {
        events.push("runtime.closed");
      },
    };
    const pairing: CliPairingClient = {
      async start() {
        events.push("channel.attached");
        return {};
      },
      async waitForCredential() {
        await provider.replace({ deviceId: DEVICE_ID, credential: CREDENTIAL });
        events.push("credential.received");
        return { deviceId: DEVICE_ID, credential: CREDENTIAL };
      },
      async close() {
        events.push("pairing.closed");
      },
    };
    const controller: CliReconnectController = {
      start() {
        events.push("bridge.started");
      },
      async stop() {
        events.push("bridge.stopped");
      },
    };
    const run = runConnectCli(["connect", "--config", "agent.json"], {
      loadConfig: createConfig,
      credentialProviderFactory: () => provider,
      runtimeFactory: () => runtime,
      pairingClientFactory: (options) => {
        pairing.start = async () => {
          events.push("channel.attached");
          options.onPairingCode?.(
            "ABCD-EFGH-JKLM",
            new Date("2026-09-18T12:05:00Z"),
          );
          return {};
        };
        return pairing;
      },
      reconnectControllerFactory: (options) => {
        expect(options.url).toBe("wss://api.example.test/bridge");
        return controller;
      },
      waitForShutdown: () => shutdown.promise,
      stdout: (message) => output.push(message),
      stderr: (message) => output.push(message),
    });

    await waitFor(() => events.includes("bridge.started"));
    expect(output.join("\n")).toContain("ABCD-EFGH-JKLM");
    expect(events.indexOf("credential.saved")).toBeLessThan(
      events.indexOf("bridge.started"),
    );
    expect(await provider.load()).toEqual({
      deviceId: DEVICE_ID,
      credential: CREDENTIAL,
    });
    shutdown.resolve();
    expect(await run).toBe(0);
    expect(events.slice(-3)).toEqual([
      "bridge.stopped",
      "pairing.closed",
      "runtime.closed",
    ]);
  });

  test("reuses a saved credential without starting another pairing flow", async () => {
    const events: string[] = [];
    const shutdown = deferred();
    const provider: DeviceCredentialProvider = {
      async load() {
        return { deviceId: DEVICE_ID, credential: CREDENTIAL };
      },
      async replace() {},
    };
    const controller: CliReconnectController = {
      start() {
        events.push("started");
      },
      async stop() {
        events.push("stopped");
      },
    };
    const run = runConnectCli(["connect", "--config", "agent.json"], {
      loadConfig: createConfig,
      credentialProviderFactory: () => provider,
      runtimeFactory: () => ({ async connect() {}, async close() {} }),
      pairingClientFactory: () => {
        throw new Error("pairing must be skipped");
      },
      reconnectControllerFactory: () => controller,
      waitForShutdown: () => shutdown.promise,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    await waitFor(() => events.includes("started"));
    shutdown.resolve();
    expect(await run).toBe(0);
    expect(events).toEqual(["started", "stopped"]);
  });

  test("returns a safe failure and closes initialized resources on storage errors", async () => {
    const output: string[] = [];
    const shutdown = deferred();
    let runtimeClosed = false;
    const result = await runConnectCli(["connect", "--config", "agent.json"], {
      loadConfig: createConfig,
      credentialProviderFactory: () => ({
        async load() {
          throw new Error(`storage failed with ${CREDENTIAL}`);
        },
        async replace() {},
      }),
      runtimeFactory: () => ({
        async connect() {},
        async close() {
          runtimeClosed = true;
        },
      }),
      waitForShutdown: () => shutdown.promise,
      stdout: (message) => output.push(message),
      stderr: (message) => output.push(message),
    });
    expect(result).toBe(1);
    expect(runtimeClosed).toBe(true);
    expect(output.join("\n")).not.toContain(CREDENTIAL);
    expect(output.join("\n")).toContain("CONNECT_FAILED");
  });

  test("prints help and rejects unsupported command forms", async () => {
    const output: string[] = [];
    expect(
      await runConnectCli(["--help"], {
        stdout: (message) => output.push(message),
      }),
    ).toBe(0);
    expect(output.join("\n")).toContain("connect --config");
    expect(await runConnectCli(["connect"], { stderr: () => undefined })).toBe(
      2,
    );
  });
});
