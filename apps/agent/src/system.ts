import { constants as fsConstants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { hostname, platform } from "node:os";
import { delimiter, isAbsolute, join, resolve, win32 } from "node:path";
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

function isPathCommand(command: string): boolean {
  return isAbsolute(command) || command.includes("/") || command.includes("\\");
}

function candidatePaths(command: string): string[] {
  const pathVariable = process.env.PATH ?? "";
  if (isPathCommand(command)) {
    return [command];
  }

  const paths = pathVariable.split(delimiter).filter(Boolean);
  if (process.platform !== "win32") {
    return paths.map((directory) => join(directory, command));
  }

  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
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

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(
      candidate,
      process.platform === "win32"
        ? fsConstants.F_OK
        : fsConstants.F_OK | fsConstants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

async function findExecutable(command: string): Promise<string | undefined> {
  for (const candidate of candidatePaths(command)) {
    if (await isExecutable(candidate)) {
      try {
        return await realpath(resolve(candidate));
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

      const executablePath = await findExecutable(input.command);
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
