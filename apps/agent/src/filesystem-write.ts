import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir as makeDirectory,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, relative } from "node:path";
import { z } from "zod";
import { ToolDomainError } from "./errors";
import type { ToolContext, ToolDefinition } from "./registry";
import type { WorkspacePathResolver } from "./workspace";

export const DEFAULT_MAX_WRITE_BYTES = 1_048_576;

const pathSchema = z.string().min(1);
const writeSchema = z
  .object({
    action: z.literal("write"),
    workspace: z.string().min(1),
    path: pathSchema,
    content: z.string(),
    overwrite: z.boolean().optional(),
    createParents: z.boolean().optional(),
  })
  .strict();
const patchSchema = z
  .object({
    action: z.literal("patch"),
    workspace: z.string().min(1),
    path: pathSchema,
    oldText: z.string().min(1),
    newText: z.string(),
    expectedOccurrences: z.number().int().min(1).max(1000).optional(),
  })
  .strict();
const mkdirSchema = z
  .object({
    action: z.literal("mkdir"),
    workspace: z.string().min(1),
    path: pathSchema,
    recursive: z.boolean().optional(),
  })
  .strict();
const moveSchema = z
  .object({
    action: z.literal("move"),
    workspace: z.string().min(1),
    from: pathSchema,
    to: pathSchema,
    overwrite: z.boolean().optional(),
  })
  .strict();

export const filesystemWriteInputSchema = z.discriminatedUnion("action", [
  writeSchema,
  patchSchema,
  mkdirSchema,
  moveSchema,
]);

const filesystemWriteOutputSchema = z.object({
  action: z.enum(["write", "patch", "mkdir", "move"]),
  path: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
  created: z.boolean().optional(),
  overwritten: z.boolean().optional(),
  occurrences: z.number().int().nonnegative().optional(),
});

type FilesystemWriteInput = z.infer<typeof filesystemWriteInputSchema>;

function displayPath(workspaceRoot: string, path: string): string {
  return relative(workspaceRoot, path).replaceAll("\\", "/") || ".";
}

function domainError(error: unknown, fallback: string): ToolDomainError {
  if (error instanceof ToolDomainError) return error;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (code === "EEXIST")
      return new ToolDomainError("ALREADY_EXISTS", fallback);
    if (code === "ENOENT")
      return new ToolDomainError("PATH_NOT_FOUND", fallback);
    if (code === "ENOTDIR")
      return new ToolDomainError("INVALID_INPUT", fallback);
    if (code === "EXDEV") {
      return new ToolDomainError(
        "INVALID_INPUT",
        "Move across filesystems is not supported",
      );
    }
  }
  return new ToolDomainError("INTERNAL_ERROR", fallback);
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = 0;
  index = content.indexOf(needle, index);
  while (index !== -1) {
    count += 1;
    index += needle.length;
    index = content.indexOf(needle, index);
  }
  return count;
}

async function ensureRegularFile(path: string): Promise<number> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch (error) {
    throw domainError(error, "Path does not exist");
  }
  if (!stats.isFile()) {
    throw new ToolDomainError("INVALID_INPUT", "Path must be a regular file");
  }
  return stats.mode & 0o7777;
}

async function atomicReplace(
  path: string,
  content: string,
  mode?: number,
): Promise<void> {
  const temporaryPath = `${path}.doctmcp-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    if (mode !== undefined) await chmod(temporaryPath, mode);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function writeNewFile(
  path: string,
  content: string,
  overwrite: boolean,
  existingMode?: number,
): Promise<void> {
  if (overwrite) {
    await atomicReplace(path, content, existingMode);
    return;
  }
  await writeFile(path, content, { encoding: "utf8", flag: "wx" });
}

function result(
  action: FilesystemWriteInput["action"],
  data: Record<string, unknown>,
) {
  const structuredContent = { action, ...data };
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(structuredContent) },
    ],
    structuredContent,
  };
}

export function createFilesystemWriteTool(
  resolver: WorkspacePathResolver,
  maxWriteBytes = DEFAULT_MAX_WRITE_BYTES,
): ToolDefinition<
  typeof filesystemWriteInputSchema,
  typeof filesystemWriteOutputSchema
> {
  if (!Number.isInteger(maxWriteBytes) || maxWriteBytes < 1) {
    throw new ToolDomainError(
      "INVALID_INPUT",
      "maxWriteBytes must be positive",
    );
  }

  return {
    name: "filesystem.write",
    description:
      "Create and modify files and directories inside a local workspace",
    inputSchema: filesystemWriteInputSchema,
    outputSchema: filesystemWriteOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
    handler: async (input, context: ToolContext) => {
      if (context.signal.aborted) {
        throw new ToolDomainError("TIMEOUT", "Filesystem write was cancelled");
      }

      if (input.action === "write") {
        const bytes = Buffer.byteLength(input.content, "utf8");
        if (bytes > maxWriteBytes) {
          throw new ToolDomainError(
            "OUTPUT_LIMIT_EXCEEDED",
            "Write content exceeds the configured limit",
          );
        }
        const resolved = await resolver.resolve(
          input.workspace,
          input.path,
          "write",
        );
        if (resolved.exists && input.overwrite !== true) {
          throw new ToolDomainError(
            "ALREADY_EXISTS",
            "Destination already exists",
          );
        }
        let existingMode: number | undefined;
        if (resolved.exists) {
          try {
            const existing = await lstat(resolved.operationPath);
            if (!existing.isFile()) {
              throw new ToolDomainError(
                "INVALID_INPUT",
                "Path must be a regular file",
              );
            }
            existingMode = existing.mode & 0o7777;
          } catch (error) {
            throw domainError(error, "Unable to inspect destination");
          }
        }
        if (input.createParents === true)
          await makeDirectory(dirname(resolved.operationPath), {
            recursive: true,
          });
        try {
          await writeNewFile(
            resolved.operationPath,
            input.content,
            input.overwrite === true,
            existingMode,
          );
        } catch (error) {
          throw domainError(error, "Unable to write file");
        }
        return result("write", {
          path: displayPath(resolved.workspace.root, resolved.operationPath),
          bytes,
          created: !resolved.exists,
          overwritten: resolved.exists,
        });
      }

      if (input.action === "patch") {
        const resolved = await resolver.resolve(
          input.workspace,
          input.path,
          "write",
        );
        const existingMode = await ensureRegularFile(resolved.operationPath);
        let content: string;
        try {
          content = await readFile(resolved.operationPath, "utf8");
        } catch (error) {
          throw domainError(error, "Unable to read file for patch");
        }
        const occurrences = countOccurrences(content, input.oldText);
        const expectedOccurrences = input.expectedOccurrences ?? 1;
        if (occurrences !== expectedOccurrences) {
          throw new ToolDomainError(
            "INVALID_INPUT",
            "Patch occurrence count does not match",
            { occurrences, expectedOccurrences },
          );
        }
        const patched = content.split(input.oldText).join(input.newText);
        if (Buffer.byteLength(patched, "utf8") > maxWriteBytes) {
          throw new ToolDomainError(
            "OUTPUT_LIMIT_EXCEEDED",
            "Patched content exceeds the configured limit",
          );
        }
        try {
          await atomicReplace(resolved.operationPath, patched, existingMode);
        } catch (error) {
          throw domainError(error, "Unable to apply patch");
        }
        return result("patch", {
          path: displayPath(resolved.workspace.root, resolved.operationPath),
          bytes: Buffer.byteLength(patched, "utf8"),
          occurrences,
        });
      }

      if (input.action === "mkdir") {
        const resolved = await resolver.resolve(
          input.workspace,
          input.path,
          "write",
        );
        if (resolved.exists) {
          let stats: Awaited<ReturnType<typeof lstat>>;
          try {
            stats = await lstat(resolved.operationPath);
          } catch (error) {
            throw domainError(error, "Unable to inspect directory");
          }
          if (!stats.isDirectory())
            throw new ToolDomainError(
              "ALREADY_EXISTS",
              "Destination already exists and is not a directory",
            );
          return result("mkdir", {
            path: displayPath(resolved.workspace.root, resolved.operationPath),
            created: false,
          });
        }
        try {
          await makeDirectory(resolved.operationPath, {
            recursive: input.recursive === true,
          });
        } catch (error) {
          throw domainError(error, "Unable to create directory");
        }
        return result("mkdir", {
          path: displayPath(resolved.workspace.root, resolved.operationPath),
          created: true,
        });
      }

      const source = await resolver.resolve(
        input.workspace,
        input.from,
        "write",
      );
      await ensureRegularFileOrDirectory(source.operationPath);
      const destination = await resolver.resolve(
        input.workspace,
        input.to,
        "write",
      );
      if (destination.exists && input.overwrite !== true)
        throw new ToolDomainError(
          "ALREADY_EXISTS",
          "Destination already exists",
        );
      try {
        await rename(source.operationPath, destination.operationPath);
      } catch (error) {
        throw domainError(error, "Unable to move path");
      }
      return result("move", {
        from: displayPath(source.workspace.root, source.operationPath),
        to: displayPath(destination.workspace.root, destination.operationPath),
        overwritten: destination.exists,
      });
    },
  };
}

async function ensureRegularFileOrDirectory(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() && !stats.isDirectory()) {
      throw new ToolDomainError(
        "INVALID_INPUT",
        "Source must be a file or directory",
      );
    }
  } catch (error) {
    throw domainError(error, "Source does not exist");
  }
}
