import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { hostname, platform } from "node:os";
import { delimiter, posix, resolve, win32 } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "./registry";

const systemInfoOutput = z.object({
  platform: z.string(),
  arch: z.string(),
  hostname: z.string(),
  runtime: z.object({
    name: z.literal("bun"),
    version: z.string(),
  }),
});

const systemWhichOutput = z.object({
  found: z.boolean(),
  path: z.string().optional(),
});

export const systemInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("info") }).strict(),
  z
    .object({
      action: z.literal("which"),
      command: z
        .string()
        .trim()
        .min(1)
        .max(1024)
        .refine((value) => !value.includes("\0"), "NUL is not allowed"),
    })
    .strict(),
]);

export const systemOutput = z.union([systemInfoOutput, systemWhichOutput]);

function currentRuntimeVersion(): string {
  return typeof Bun !== "undefined" && Bun.version
    ? Bun.version
    : process.version;
}

export interface ExecutableResolverOptions {
  platform?: NodeJS.Platform;
  pathValue?: string;
  pathExt?: string;
  isFile?: (candidate: string) => Promise<boolean>;
  canonicalize?: (candidate: string) => Promise<string>;
}

function isPathCommand(
  command: string,
  targetPlatform: NodeJS.Platform,
): boolean {
  const pathApi = targetPlatform === "win32" ? win32 : posix;
  return (
    pathApi.isAbsolute(command) ||
    command.includes("/") ||
    command.includes("\\")
  );
}

function candidatePaths(
  command: string,
  targetPlatform: NodeJS.Platform,
  pathValue: string,
  pathExt: string,
): string[] {
  if (isPathCommand(command, targetPlatform)) {
    return [command];
  }

  const pathDelimiter = targetPlatform === "win32" ? ";" : delimiter;
  const paths = pathValue.split(pathDelimiter).filter(Boolean);
  if (targetPlatform !== "win32") {
    return paths.map((directory) => posix.join(directory, command));
  }

  const extensions = pathExt.split(";").filter(Boolean);
  const hasExtension = extensions.some((extension) =>
    command.toLowerCase().endsWith(extension.toLowerCase()),
  );
  const names = hasExtension
    ? [command]
    : [command, ...extensions.map((extension) => `${command}${extension}`)];
  return paths.flatMap((directory) =>
    names.map((name) => win32.join(directory, name)),
  );
}

async function isExecutable(
  candidate: string,
  targetPlatform: NodeJS.Platform,
): Promise<boolean> {
  try {
    if (!(await stat(candidate)).isFile()) {
      return false;
    }
    await access(
      candidate,
      targetPlatform === "win32"
        ? fsConstants.F_OK
        : fsConstants.F_OK | fsConstants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

export async function resolveExecutable(
  command: string,
  options: ExecutableResolverOptions = {},
): Promise<string | undefined> {
  const targetPlatform = options.platform ?? process.platform;
  const candidates = candidatePaths(
    command,
    targetPlatform,
    options.pathValue ?? process.env.PATH ?? "",
    options.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
  );
  const checkFile =
    options.isFile ??
    ((candidate: string) => isExecutable(candidate, targetPlatform));
  const canonicalize =
    options.canonicalize ??
    (async (candidate: string) => realpath(resolve(candidate)));

  for (const candidate of candidates) {
    if (await checkFile(candidate)) {
      try {
        return await canonicalize(candidate);
      } catch {
        return resolve(candidate);
      }
    }
  }
  return undefined;
}

export function createSystemTool(): ToolDefinition<
  typeof systemInput,
  typeof systemOutput
> {
  return {
    name: "system",
    description: "Read basic local system information and resolve executables",
    inputSchema: systemInput,
    outputSchema: systemOutput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (input) => {
      if (input.action === "info") {
        const result = {
          platform: platform(),
          arch: process.arch,
          hostname: hostname(),
          runtime: { name: "bun" as const, version: currentRuntimeVersion() },
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }

      const executablePath = await resolveExecutable(input.command);
      const result = executablePath
        ? { found: true as const, path: executablePath }
        : { found: false as const };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  };
}
