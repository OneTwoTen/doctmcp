import {
  type AgentConfig,
  AgentConfigError,
  loadAgentConfig,
} from "./cli-config";
import {
  type DeviceCredentialProvider,
  FileDeviceCredentialProvider,
  type LocalDeviceCredential,
} from "./device-credential-provider";
import { LocalBridgeReconnectController } from "./local-bridge-reconnect";
import { createLocalMcpRuntime } from "./local-mcp-runtime";
import {
  LocalPairingClient,
  type LocalPairingClientOptions,
} from "./pairing-client";
import type { LocalMcpServerInstance } from "./server";

export interface CliRuntime
  extends Pick<LocalMcpServerInstance, "connect" | "close"> {}

export interface CliPairingClient {
  start(): Promise<unknown>;
  waitForCredential(): Promise<LocalDeviceCredential>;
  close(): Promise<void>;
}

export interface CliReconnectController {
  start(): void;
  stop(): Promise<void>;
}

export interface CliReconnectControllerOptions {
  readonly url: string;
  readonly runtime: CliRuntime;
  readonly credentialProvider: DeviceCredentialProvider;
}

export interface ConnectCliDependencies {
  readonly loadConfig?: (path: string) => Promise<AgentConfig>;
  readonly credentialProviderFactory?: (
    config: AgentConfig,
  ) => DeviceCredentialProvider;
  readonly runtimeFactory?: (config: AgentConfig) => CliRuntime;
  readonly pairingClientFactory?: (
    options: LocalPairingClientOptions,
  ) => CliPairingClient;
  readonly reconnectControllerFactory?: (
    options: CliReconnectControllerOptions,
  ) => CliReconnectController;
  readonly waitForShutdown?: () => Promise<void>;
  readonly stdout?: (message: string) => void;
  readonly stderr?: (message: string) => void;
}

const USAGE = `doctmcp-agent connect --config <path>

Kết nối MCP runtime local với doctmcp server.
`;

function parseConfigPath(
  argv: readonly string[],
):
  | { readonly kind: "help" }
  | { readonly kind: "connect"; readonly path: string }
  | { readonly kind: "invalid" } {
  if (
    argv.length === 0 ||
    argv[0] === "--help" ||
    argv[0] === "-h" ||
    (argv[0] === "connect" && (argv[1] === "--help" || argv[1] === "-h"))
  ) {
    return { kind: "help" };
  }
  if (argv[0] !== "connect") return { kind: "invalid" };
  if (argv.length !== 3 || argv[1] !== "--config" || !argv[2]) {
    return { kind: "invalid" };
  }
  return { kind: "connect", path: argv[2] };
}

function bridgeUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/bridge";
  url.search = "";
  url.hash = "";
  return url.href;
}

function systemShutdownSignal(): Promise<void> {
  return new Promise((resolveSignal) => {
    const onSignal = (): void => resolveSignal();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

function failureCode(error: unknown): string {
  if (error instanceof AgentConfigError) return error.code;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string"
  ) {
    return (error as { readonly code: string }).code;
  }
  return "CONNECT_FAILED";
}

export async function runConnectCli(
  argv: readonly string[],
  dependencies: ConnectCliDependencies = {},
): Promise<number> {
  const parsed = parseConfigPath(argv);
  const stdout =
    dependencies.stdout ?? ((message: string) => console.log(message));
  const stderr =
    dependencies.stderr ?? ((message: string) => console.error(message));
  if (parsed.kind === "help") {
    stdout(USAGE);
    return 0;
  }
  if (parsed.kind === "invalid") {
    stderr(USAGE);
    return 2;
  }

  const waitForShutdown = dependencies.waitForShutdown ?? systemShutdownSignal;
  const shutdown = waitForShutdown();
  let runtime: CliRuntime | undefined;
  let pairing: CliPairingClient | undefined;
  let controller: CliReconnectController | undefined;
  let exitCode = 0;
  try {
    const config = await (dependencies.loadConfig ?? loadAgentConfig)(
      parsed.path,
    );
    const credentialProvider =
      dependencies.credentialProviderFactory?.(config) ??
      new FileDeviceCredentialProvider(config.credentialPath);
    runtime =
      dependencies.runtimeFactory?.(config) ??
      createLocalMcpRuntime(config.workspaceRegistry);

    const savedCredential = await credentialProvider.load();
    if (!savedCredential) {
      pairing = (
        dependencies.pairingClientFactory ??
        ((options) => new LocalPairingClient(options))
      )({
        serverUrl: config.serverUrl,
        deviceName: config.deviceName,
        credentialProvider,
        onPairingCode: (code, expiresAt) => {
          stdout(`Pairing code: ${code}`);
          stdout(`Hết hạn lúc: ${expiresAt.toLocaleString()}`);
          stdout(
            "Nhập code này vào devices_pair trong ChatGPT để ghép thiết bị.",
          );
        },
      });
      const startResult = await Promise.race([
        pairing.start().then(() => "attached" as const),
        shutdown.then(() => "shutdown" as const),
      ]);
      if (startResult === "shutdown") return 0;
      const pairingResult = await Promise.race([
        pairing.waitForCredential().then(() => "paired" as const),
        shutdown.then(() => "shutdown" as const),
      ]);
      if (pairingResult === "shutdown") return 0;
      stdout("Pairing hoàn tất; đang kết nối MCP runtime local.");
    }

    controller =
      dependencies.reconnectControllerFactory?.({
        url: bridgeUrl(config.serverUrl),
        runtime,
        credentialProvider,
      }) ??
      new LocalBridgeReconnectController({
        url: bridgeUrl(config.serverUrl),
        runtime,
        credentialProvider,
      });
    controller.start();
    stdout("Local MCP runtime đang chạy. Nhấn Ctrl+C để dừng.");
    await shutdown;
  } catch (error) {
    exitCode = 1;
    stderr(`Không thể kết nối doctmcp (${failureCode(error)}).`);
  } finally {
    await controller?.stop().catch(() => undefined);
    await pairing?.close().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
  }
  return exitCode;
}

if (import.meta.main) {
  process.exitCode = await runConnectCli(Bun.argv.slice(2));
}
