import { Buffer } from "node:buffer";
import { type ChildProcess, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { win32 } from "node:path";
import { z } from "zod";
import { ToolDomainError } from "./errors";
import type { ToolContext, ToolDefinition } from "./registry";
import { resolveExecutable } from "./system";
import { WorkspacePathResolver, type WorkspaceRegistry } from "./workspace";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_KILL_GRACE_MS = 250;

const DEFAULT_DENIED_COMMANDS = ["sudo", "shutdown", "reboot"] as const;
const DEFAULT_ENVIRONMENT_ALLOWLIST = [
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "TMP",
  "TEMP",
  "TMPDIR",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
] as const;

const WINDOWS_BATCH_EXTENSION = /\.(cmd|bat)$/i;
const WINDOWS_BATCH_UNSAFE_TOKEN = /[\r\n"&|<>^%!()]/;

const stringWithoutNullByte = z
  .string()
  .refine((value) => !value.includes("\0"), "NUL bytes are not allowed");

const shellExecInput = z
  .object({
    workspace: z.string().min(1),
    command: z
      .string()
      .trim()
      .min(1)
      .max(1024)
      .refine((value) => !value.includes("\0"), "NUL bytes are not allowed"),
    args: z.array(stringWithoutNullByte).default([]),
    cwd: z
      .string()
      .min(1)
      .refine((value) => !value.includes("\0"), "NUL bytes are not allowed")
      .default("."),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

const shellExecOutput = z.object({
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

type ShellExecTool = ToolDefinition<
  typeof shellExecInput,
  typeof shellExecOutput
>;

type TerminationReason = "timeout" | "output" | "cancelled";

type SpawnedChild = ChildProcess;

interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  terminationReason?: TerminationReason;
}

interface SpawnInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
}

export interface ShellExecToolOptions {
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
  deniedCommands?: readonly string[];
  environmentAllowlist?: readonly string[];
}

interface ResolvedShellExecOptions {
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly killGraceMs: number;
  readonly deniedCommands: ReadonlySet<string>;
  readonly environmentAllowlist: readonly string[];
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ToolDomainError(
      "INVALID_INPUT",
      `${name} must be a positive safe integer`,
    );
  }
  return value;
}

function normalizeCommandName(command: string): string {
  const normalized = command.trim().replaceAll("\\", "/");
  const lastSlash = normalized.lastIndexOf("/");
  const basename =
    lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  return basename.replace(/\.(exe|cmd|bat|com)$/i, "").toLowerCase();
}

function resolveOptions(
  options: ShellExecToolOptions,
): ResolvedShellExecOptions {
  const defaultTimeoutMs = positiveInteger(
    options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    "defaultTimeoutMs",
  );
  const maxTimeoutMs = positiveInteger(
    options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS,
    "maxTimeoutMs",
  );
  if (defaultTimeoutMs > maxTimeoutMs) {
    throw new ToolDomainError(
      "INVALID_INPUT",
      "defaultTimeoutMs cannot exceed maxTimeoutMs",
    );
  }

  const maxOutputBytes = positiveInteger(
    options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    "maxOutputBytes",
  );
  const killGraceMs = positiveInteger(
    options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    "killGraceMs",
  );
  const deniedCommands = new Set(
    (options.deniedCommands ?? DEFAULT_DENIED_COMMANDS).map((command) => {
      const normalized = normalizeCommandName(command);
      if (!normalized) {
        throw new ToolDomainError(
          "INVALID_INPUT",
          "deniedCommands cannot contain empty command names",
        );
      }
      return normalized;
    }),
  );
  const environmentAllowlist = Object.freeze([
    ...(options.environmentAllowlist ?? DEFAULT_ENVIRONMENT_ALLOWLIST),
  ]);
  if (environmentAllowlist.some((name) => !name.trim())) {
    throw new ToolDomainError(
      "INVALID_INPUT",
      "environmentAllowlist cannot contain empty names",
    );
  }

  return {
    defaultTimeoutMs,
    maxTimeoutMs,
    maxOutputBytes,
    killGraceMs,
    deniedCommands,
    environmentAllowlist,
  };
}

function readEnvironmentVariable(name: string): string | undefined {
  const direct = process.env[name];
  if (direct !== undefined || process.platform !== "win32") {
    return direct;
  }
  const lowerName = name.toLowerCase();
  const match = Object.entries(process.env).find(
    ([key]) => key.toLowerCase() === lowerName,
  );
  return match?.[1];
}

function buildProcessEnvironment(
  allowlist: readonly string[],
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of allowlist) {
    const value = readEnvironmentVariable(name);
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

function processStartError(error: unknown): ToolDomainError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") {
    return new ToolDomainError("PROCESS_FAILED", "Command was not found");
  }
  if (code === "EACCES" || code === "EPERM") {
    return new ToolDomainError(
      "PERMISSION_DENIED",
      "Command cannot be executed by the local runtime",
    );
  }
  return new ToolDomainError("PROCESS_FAILED", "Process could not be started");
}

function assertSafeWindowsBatchToken(value: string, label: string): void {
  if (WINDOWS_BATCH_UNSAFE_TOKEN.test(value)) {
    throw new ToolDomainError(
      "INVALID_INPUT",
      `${label} contains characters that are unsafe for Windows batch execution`,
    );
  }
}

function prepareSpawnInvocation(
  executablePath: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): SpawnInvocation {
  if (
    process.platform !== "win32" ||
    !WINDOWS_BATCH_EXTENSION.test(executablePath)
  ) {
    return {
      command: executablePath,
      args,
      windowsVerbatimArguments: false,
    };
  }

  assertSafeWindowsBatchToken(executablePath, "Command path");
  for (const [index, arg] of args.entries()) {
    assertSafeWindowsBatchToken(arg, `args[${index}]`);
  }

  const systemRoot = environment.SystemRoot ?? environment.WINDIR;
  const comspec =
    environment.COMSPEC ??
    (systemRoot ? win32.join(systemRoot, "System32", "cmd.exe") : "cmd.exe");
  const commandLine = [executablePath, ...args]
    .map((token) => `"${token}"`)
    .join(" ");

  return {
    command: comspec,
    args: ["/d", "/v:off", "/s", "/c", `"${commandLine}"`],
    // cmd.exe parses the remainder after /c itself. The tokens above are already
    // conservatively validated and quoted, so prevent libuv from re-quoting them.
    windowsVerbatimArguments: true,
  };
}

function signalPosixProcessGroup(
  child: SpawnedChild,
  signal: NodeJS.Signals,
): void {
  const pid = child.pid;
  if (!pid) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function terminatePosixProcessTree(
  child: SpawnedChild,
  killGraceMs: number,
): Promise<void> {
  signalPosixProcessGroup(child, "SIGTERM");
  await new Promise<void>((resolve) => setTimeout(resolve, killGraceMs));
  signalPosixProcessGroup(child, "SIGKILL");
}

function taskkillPath(environment: NodeJS.ProcessEnv): string {
  const systemRoot = environment.SystemRoot ?? environment.WINDIR;
  return systemRoot
    ? win32.join(systemRoot, "System32", "taskkill.exe")
    : "taskkill.exe";
}

async function terminateWindowsProcessTree(
  child: SpawnedChild,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    child.kill("SIGKILL");
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (fallback: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (fallback && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    };

    let killer: SpawnedChild;
    try {
      killer = spawn(
        taskkillPath(environment),
        ["/PID", String(pid), "/T", "/F"],
        {
          env: environment,
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        },
      );
    } catch {
      finish(true);
      return;
    }

    killer.once("error", () => finish(true));
    killer.once("close", (code) => finish(code !== 0));
  });
}

function terminateProcessTree(
  child: SpawnedChild,
  options: ResolvedShellExecOptions,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  if (process.platform === "win32") {
    return terminateWindowsProcessTree(child, environment);
  }
  return terminatePosixProcessTree(child, options.killGraceMs);
}

async function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  options: ResolvedShellExecOptions,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<ProcessResult> {
  if (signal.aborted) {
    throw new ToolDomainError(
      "PROCESS_FAILED",
      "Process execution was cancelled",
    );
  }

  const invocation = prepareSpawnInvocation(command, args, environment);

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;
    let truncated = false;
    let terminationReason: TerminationReason | undefined;
    let terminationPromise: Promise<void> | undefined;
    let settled = false;
    let closed = false;

    let child: SpawnedChild;
    try {
      child = spawn(invocation.command, [...invocation.args], {
        cwd,
        env: environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      reject(processStartError(error));
      return;
    }

    const requestTermination = (reason: TerminationReason): void => {
      if (!terminationReason) {
        terminationReason = reason;
      }
      if (
        closed ||
        child.exitCode !== null ||
        child.signalCode !== null ||
        terminationPromise
      ) {
        return;
      }
      terminationPromise = terminateProcessTree(child, options, environment);
    };

    const appendOutput = (chunk: unknown, target: Buffer[]): void => {
      if (truncated) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk));
      const remaining = options.maxOutputBytes - capturedBytes;
      if (remaining <= 0) {
        truncated = true;
        requestTermination("output");
        return;
      }
      if (buffer.byteLength > remaining) {
        target.push(buffer.subarray(0, remaining));
        capturedBytes += remaining;
        truncated = true;
        requestTermination("output");
        return;
      }
      target.push(buffer);
      capturedBytes += buffer.byteLength;
    };

    const onAbort = (): void => requestTermination("cancelled");
    signal.addEventListener("abort", onAbort, { once: true });

    const timeout = setTimeout(() => requestTermination("timeout"), timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    };

    child.stdout?.on("data", (chunk) => appendOutput(chunk, stdoutChunks));
    child.stderr?.on("data", (chunk) => appendOutput(chunk, stderrChunks));

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(processStartError(error));
    });

    child.once("close", (exitCode, processSignal) => {
      closed = true;
      void (async () => {
        if (terminationPromise) {
          await terminationPromise;
        }
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve({
          exitCode,
          signal: processSignal,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          durationMs: Math.max(0, Date.now() - startedAt),
          truncated,
          ...(terminationReason ? { terminationReason } : {}),
        });
      })();
    });
  });
}

export function createShellExecTool(
  registry: WorkspaceRegistry,
  options: ShellExecToolOptions = {},
): ShellExecTool {
  const resolver = new WorkspacePathResolver(registry);
  const resolvedOptions = resolveOptions(options);

  return {
    name: "shell.exec",
    description:
      "Execute a command directly inside a configured workspace with bounded output and timeout",
    inputSchema: shellExecInput,
    outputSchema: shellExecOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    handler: async (
      { workspace, command, args, cwd, timeoutMs },
      context: ToolContext,
    ) => {
      const effectiveTimeoutMs = timeoutMs ?? resolvedOptions.defaultTimeoutMs;
      if (effectiveTimeoutMs > resolvedOptions.maxTimeoutMs) {
        throw new ToolDomainError(
          "INVALID_INPUT",
          `timeoutMs cannot exceed ${resolvedOptions.maxTimeoutMs}`,
        );
      }

      const resolvedCwd = await resolver.resolve(workspace, cwd, "execute");
      if (!resolvedCwd.exists) {
        throw new ToolDomainError(
          "PATH_NOT_FOUND",
          "Working directory does not exist",
        );
      }
      const cwdStat = await stat(resolvedCwd.operationPath).catch(() => {
        throw new ToolDomainError(
          "PATH_NOT_FOUND",
          "Working directory does not exist",
        );
      });
      if (!cwdStat.isDirectory()) {
        throw new ToolDomainError(
          "INVALID_INPUT",
          "Working directory must be a directory",
        );
      }

      const requestedCommandName = normalizeCommandName(command);
      if (resolvedOptions.deniedCommands.has(requestedCommandName)) {
        throw new ToolDomainError(
          "PERMISSION_DENIED",
          "Command is denied by local shell policy",
        );
      }

      const environment = buildProcessEnvironment(
        resolvedOptions.environmentAllowlist,
      );
      const executablePath = await resolveExecutable(command, {
        cwd: resolvedCwd.operationPath,
        pathValue: environment.PATH ?? "",
        pathExt: environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
      });
      if (!executablePath) {
        throw new ToolDomainError("PROCESS_FAILED", "Command was not found");
      }
      if (
        resolvedOptions.deniedCommands.has(normalizeCommandName(executablePath))
      ) {
        throw new ToolDomainError(
          "PERMISSION_DENIED",
          "Command is denied by local shell policy",
        );
      }

      const result = await runProcess(
        executablePath,
        args,
        resolvedCwd.operationPath,
        effectiveTimeoutMs,
        resolvedOptions,
        environment,
        context.signal,
      );

      if (result.terminationReason === "timeout") {
        throw new ToolDomainError(
          "TIMEOUT",
          "Process exceeded the configured timeout",
          { timeoutMs: effectiveTimeoutMs },
        );
      }
      if (result.terminationReason === "cancelled") {
        throw new ToolDomainError(
          "PROCESS_FAILED",
          "Process execution was cancelled",
        );
      }

      const structuredContent = {
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        truncated: result.truncated,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    },
  };
}
