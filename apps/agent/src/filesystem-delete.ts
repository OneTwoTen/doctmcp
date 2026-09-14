import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import { z } from "zod";
import { ToolDomainError } from "./errors";
import type { ToolDefinition } from "./registry";
import { WorkspacePathResolver, type WorkspaceRegistry } from "./workspace";

const filesystemDeleteInput = z
  .object({
    workspace: z.string().min(1),
    path: z.string(),
    recursive: z.boolean().default(false),
  })
  .strict();

const filesystemDeleteOutput = z.object({
  deleted: z.literal(true),
  path: z.string(),
  type: z.enum(["file", "directory"]),
});

type FilesystemDeleteTool = ToolDefinition<
  typeof filesystemDeleteInput,
  typeof filesystemDeleteOutput
>;

export function createFilesystemDeleteTool(
  registry: WorkspaceRegistry,
): FilesystemDeleteTool {
  const resolver = new WorkspacePathResolver(registry);

  return {
    name: "filesystem.delete",
    description: "Delete a file or directory inside a configured workspace",
    inputSchema: filesystemDeleteInput,
    outputSchema: filesystemDeleteOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
    handler: async ({ workspace, path, recursive }) => {
      const resolved = await resolver.resolve(workspace, path, "delete");
      if (!resolved.exists) {
        throw new ToolDomainError("PATH_NOT_FOUND", "Target does not exist");
      }

      const target = await lstat(resolved.operationPath).catch(() => {
        throw new ToolDomainError("PATH_NOT_FOUND", "Target does not exist");
      });
      const isDirectory = target.isDirectory();
      if (!target.isFile() && !isDirectory && !target.isSymbolicLink()) {
        throw new ToolDomainError(
          "PERMISSION_DENIED",
          "Target type is not supported for deletion",
        );
      }
      if (isDirectory && !recursive) {
        const entries = await readdir(resolved.operationPath);
        if (entries.length > 0) {
          throw new ToolDomainError(
            "PERMISSION_DENIED",
            "Non-empty directory requires recursive=true",
          );
        }
      }

      try {
        if (isDirectory && !recursive) {
          await rmdir(resolved.operationPath);
        } else {
          await rm(resolved.operationPath, { recursive });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new ToolDomainError("PATH_NOT_FOUND", "Target does not exist");
        }
        throw error;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              deleted: true,
              path,
              type: isDirectory ? "directory" : "file",
            }),
          },
        ],
        structuredContent: {
          deleted: true,
          path,
          type: isDirectory ? "directory" : "file",
        },
      };
    },
  };
}
