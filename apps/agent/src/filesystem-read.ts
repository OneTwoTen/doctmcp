import type { Dirent } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import { ToolDomainError } from "./errors";
import type { ToolDefinition } from "./registry";
import {
  isPathInside,
  type WorkspaceMetadata,
  type WorkspacePathResolver,
} from "./workspace";

const MAX_READ_LIMIT = 1048576; // 1 MB
const DEFAULT_READ_LIMIT = 65536; // 64 KB
const MAX_SEARCH_FILES = 1000; // Giới hạn số lượng file scan
const MAX_SEARCH_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
const MAX_SEARCH_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_SEARCH_LINE_PREVIEW = 200;

export const filesystemReadInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("read"),
      workspace: z.string().min(1),
      path: z.string().min(1),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(MAX_READ_LIMIT).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("list"),
      workspace: z.string().min(1),
      path: z.string().optional(),
      recursive: z.boolean().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      maxDepth: z.number().int().min(1).max(10).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("stat"),
      workspace: z.string().min(1),
      path: z.string().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("search"),
      workspace: z.string().min(1),
      path: z.string().optional(),
      query: z.string().min(1),
      maxResults: z.number().int().min(1).max(200).optional(),
    })
    .strict(),
]);

export type FilesystemReadInput = z.infer<typeof filesystemReadInputSchema>;

export const filesystemReadOutputSchema = z.object({
  action: z.enum(["read", "list", "stat", "search"]),
  path: z.string().optional(),
  content: z.string().optional(),
  size: z.number().optional(),
  offset: z.number().optional(),
  limit: z.number().optional(),
  bytesRead: z.number().optional(),
  nextOffset: z.number().optional(),
  entries: z
    .array(
      z.object({
        name: z.string(),
        path: z.string(),
        type: z.enum(["file", "directory", "symlink", "other"]),
        size: z.number().optional(),
      }),
    )
    .optional(),
  type: z.enum(["file", "directory", "symlink", "other"]).optional(),
  mtimeMs: z.number().optional(),
  birthtimeMs: z.number().optional(),
  isSymbolicLink: z.boolean().optional(),
  query: z.string().optional(),
  matches: z
    .array(
      z.object({
        path: z.string(),
        lineNumber: z.number(),
        line: z.string(),
      }),
    )
    .optional(),
  truncated: z.boolean().optional(),
});

export type FilesystemReadOutput = z.infer<typeof filesystemReadOutputSchema>;

function isDenied(workspace: WorkspaceMetadata, targetPath: string): boolean {
  return workspace.deny.some((denyPath) => {
    const fullDeny = join(workspace.root, denyPath);
    return isPathInside(fullDeny, targetPath);
  });
}

function isBinaryBuffer(buffer: Uint8Array): boolean {
  const checkLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLength; i += 1) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Nếu buffer bị cắt ngang giữa sequence multi-byte UTF-8 ở cuối chunk,
 * hàm này tính độ dài an toàn cần cắt lại để chỉ chứa các ký tự UTF-8 trọn vẹn.
 */
function trimIncompleteUtf8Sequence(buffer: Uint8Array): number {
  const len = buffer.length;
  if (len === 0) return 0;

  for (let i = 1; i <= Math.min(4, len); i += 1) {
    const byte = buffer[len - i];
    if (byte === undefined) break;

    // Byte ASCII (0xxxxxxx) -> sequence trước đó đã hoàn tất
    if ((byte & 0x80) === 0) {
      return len;
    }

    // Leading byte (11xxxxxx)
    if ((byte & 0xc0) === 0xc0) {
      let expectedLength = 1;
      if ((byte & 0xe0) === 0xc0) expectedLength = 2;
      else if ((byte & 0xf0) === 0xe0) expectedLength = 3;
      else if ((byte & 0xf8) === 0xf0) expectedLength = 4;

      const availableLength = i;
      if (availableLength < expectedLength) {
        return len - availableLength;
      }
      return len;
    }
  }
  return len;
}

export function createFilesystemReadTool(
  resolver: WorkspacePathResolver,
): ToolDefinition<
  typeof filesystemReadInputSchema,
  typeof filesystemReadOutputSchema
> {
  return {
    name: "filesystem.read",
    description:
      "Read-only filesystem operations inside workspace (read, list, stat, search)",
    inputSchema: filesystemReadInputSchema,
    outputSchema: filesystemReadOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (input, context) => {
      switch (input.action) {
        case "read": {
          const resolved = await resolver.resolve(
            input.workspace,
            input.path,
            "read",
          );
          if (!resolved.exists) {
            throw new ToolDomainError(
              "PATH_NOT_FOUND",
              `File '${input.path}' does not exist`,
            );
          }

          const fileStat = await lstat(resolved.operationPath);
          const targetStat = fileStat.isSymbolicLink()
            ? await stat(resolved.operationPath)
            : fileStat;

          if (targetStat.isDirectory()) {
            throw new ToolDomainError(
              "INVALID_INPUT",
              `Target '${input.path}' is a directory, not a file`,
            );
          }
          if (!targetStat.isFile()) {
            throw new ToolDomainError(
              "INVALID_INPUT",
              `Target '${input.path}' is not a regular file`,
            );
          }

          const totalSize = targetStat.size;
          const offset = input.offset ?? 0;
          const limit = input.limit ?? DEFAULT_READ_LIMIT;
          const readLength = Math.max(0, Math.min(limit, totalSize - offset));

          const rawBuffer = Buffer.alloc(readLength);
          if (readLength > 0) {
            const handle = await open(resolved.operationPath, "r");
            try {
              await handle.read(rawBuffer, 0, readLength, offset);
            } finally {
              await handle.close();
            }
          }

          if (isBinaryBuffer(rawBuffer)) {
            throw new ToolDomainError(
              "INVALID_INPUT",
              "Cannot read binary file as text",
            );
          }

          // Điều chỉnh boundary nếu chunk cắt ngang ở giữa ký tự multi-byte UTF-8
          let validLength = readLength;
          if (offset + readLength < totalSize) {
            validLength = trimIncompleteUtf8Sequence(rawBuffer);
          }

          if (readLength > 0 && validLength === 0) {
            throw new ToolDomainError(
              "INVALID_INPUT",
              "Read limit is too small to decode a complete UTF-8 character at current offset",
            );
          }

          const bufferToDecode =
            validLength === readLength
              ? rawBuffer
              : rawBuffer.subarray(0, validLength);

          let content: string;
          try {
            const decoder = new TextDecoder("utf-8", { fatal: true });
            content = decoder.decode(bufferToDecode);
          } catch {
            throw new ToolDomainError(
              "INVALID_INPUT",
              "Cannot read binary file as text: invalid UTF-8 encoding",
            );
          }

          const bytesRead = validLength;
          const nextOffset = offset + bytesRead;
          const truncated = nextOffset < totalSize;
          const result: FilesystemReadOutput = {
            action: "read",
            path: input.path,
            content,
            size: totalSize,
            offset,
            limit,
            bytesRead,
            nextOffset,
            truncated,
          };

          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        }

        case "list": {
          const relativeTarget = input.path || ".";
          const resolved = await resolver.resolve(
            input.workspace,
            relativeTarget,
            "read",
          );
          if (!resolved.exists) {
            throw new ToolDomainError(
              "PATH_NOT_FOUND",
              `Directory '${relativeTarget}' does not exist`,
            );
          }

          const targetLstat = await lstat(resolved.operationPath);
          const targetStat = targetLstat.isSymbolicLink()
            ? await stat(resolved.operationPath)
            : targetLstat;

          if (!targetStat.isDirectory()) {
            throw new ToolDomainError(
              "INVALID_INPUT",
              `Target '${relativeTarget}' is a file, not a directory`,
            );
          }

          const limit = input.limit ?? 200;
          const maxDepth = input.maxDepth ?? 5;
          const isRecursive = input.recursive ?? false;

          interface QueueItem {
            operationPath: string;
            canonicalPath: string;
            currentDepth: number;
          }

          const queue: QueueItem[] = [
            {
              operationPath: resolved.operationPath,
              canonicalPath: resolved.canonicalPath,
              currentDepth: 0,
            },
          ];
          const entries: NonNullable<FilesystemReadOutput["entries"]> = [];
          let truncated = false;

          while (queue.length > 0 && !truncated) {
            if (context?.signal?.aborted) {
              throw new ToolDomainError(
                "TIMEOUT",
                "List operation was cancelled or timed out",
              );
            }
            const current = queue.shift();
            if (!current) break;

            let dirEntries: Dirent[];
            try {
              dirEntries = await readdir(current.operationPath, {
                withFileTypes: true,
              });
            } catch {
              continue;
            }

            // Sắp xếp tên mục trong thư mục để kết quả nhất quán
            dirEntries.sort((a, b) => a.name.localeCompare(b.name));

            for (const entry of dirEntries) {
              if (context?.signal?.aborted) {
                throw new ToolDomainError(
                  "TIMEOUT",
                  "List operation was cancelled or timed out",
                );
              }
              const fullEntryPath = join(current.operationPath, entry.name);
              const canonicalEntryPath = join(
                current.canonicalPath,
                entry.name,
              );

              // Kiểm tra deny list trên cả operation path lẫn canonical path
              if (
                isDenied(resolved.workspace, fullEntryPath) ||
                isDenied(resolved.workspace, canonicalEntryPath)
              ) {
                continue;
              }

              let entryType: "file" | "directory" | "symlink" | "other" =
                "other";
              let entrySize: number | undefined;

              if (entry.isSymbolicLink()) {
                // Kiểm tra symlink target có trỏ ra ngoài workspace không
                try {
                  const targetCanonical = await realpath(fullEntryPath);
                  if (
                    !isPathInside(resolved.workspace.root, targetCanonical) ||
                    isDenied(resolved.workspace, targetCanonical)
                  ) {
                    continue; // Bỏ qua symlink trỏ ra ngoài hoặc vào deny
                  }
                  entryType = "symlink";
                } catch {
                  // Broken symlink
                  entryType = "symlink";
                }
              } else if (entry.isDirectory()) {
                entryType = "directory";
                if (isRecursive && current.currentDepth + 1 < maxDepth) {
                  queue.push({
                    operationPath: fullEntryPath,
                    canonicalPath: canonicalEntryPath,
                    currentDepth: current.currentDepth + 1,
                  });
                }
              } else if (entry.isFile()) {
                entryType = "file";
                try {
                  const s = await lstat(fullEntryPath);
                  entrySize = s.size;
                } catch {
                  // ignore
                }
              }

              const relFromWorkspace = relative(
                resolved.workspace.root,
                fullEntryPath,
              );
              entries.push({
                name: entry.name,
                path: relFromWorkspace,
                type: entryType,
                ...(entrySize !== undefined ? { size: entrySize } : {}),
              });

              if (entries.length >= limit) {
                truncated = true;
                break;
              }
            }
          }

          const result: FilesystemReadOutput = {
            action: "list",
            path: relativeTarget,
            entries,
            truncated,
          };

          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        }

        case "stat": {
          const relativeTarget = input.path || ".";
          const resolved = await resolver.resolve(
            input.workspace,
            relativeTarget,
            "read",
          );
          if (!resolved.exists) {
            throw new ToolDomainError(
              "PATH_NOT_FOUND",
              `Path '${relativeTarget}' does not exist`,
            );
          }

          const entryLstat = await lstat(resolved.operationPath);
          const isSymbolicLink = entryLstat.isSymbolicLink();

          let type: "file" | "directory" | "symlink" | "other" = "other";
          if (isSymbolicLink) {
            type = "symlink";
          } else if (entryLstat.isDirectory()) {
            type = "directory";
          } else if (entryLstat.isFile()) {
            type = "file";
          }

          const result: FilesystemReadOutput = {
            action: "stat",
            path: relativeTarget,
            type,
            size: entryLstat.size,
            mtimeMs: entryLstat.mtimeMs,
            birthtimeMs: entryLstat.birthtimeMs,
            isSymbolicLink,
          };

          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        }

        case "search": {
          const relativeTarget = input.path || ".";
          const resolved = await resolver.resolve(
            input.workspace,
            relativeTarget,
            "read",
          );
          if (!resolved.exists) {
            throw new ToolDomainError(
              "PATH_NOT_FOUND",
              `Path '${relativeTarget}' does not exist`,
            );
          }

          const maxResults = input.maxResults ?? 50;
          const matches: NonNullable<FilesystemReadOutput["matches"]> = [];
          let truncated = false;
          let totalBytesScanned = 0;
          let filesScanned = 0;

          const searchFile = async (
            filePath: string,
            relPath: string,
          ): Promise<boolean> => {
            if (context?.signal?.aborted) {
              throw new ToolDomainError(
                "TIMEOUT",
                "Search operation was cancelled or timed out",
              );
            }

            if (filesScanned >= MAX_SEARCH_FILES) {
              truncated = true;
              return true;
            }
            filesScanned += 1;

            let fileStat: Awaited<ReturnType<typeof stat>>;
            try {
              // Dùng stat thay vì lstat để nếu là symlink nội bộ, lấy được size thực của file đích
              fileStat = await stat(filePath);
            } catch {
              return false;
            }

            if (!fileStat.isFile() || fileStat.size > MAX_SEARCH_FILE_SIZE) {
              return false;
            }
            if (totalBytesScanned + fileStat.size > MAX_SEARCH_TOTAL_BYTES) {
              truncated = true;
              return true;
            }

            totalBytesScanned += fileStat.size;

            let fileBuffer: Buffer;
            try {
              const fileHandle = await open(filePath, "r");
              try {
                fileBuffer = Buffer.alloc(fileStat.size);
                await fileHandle.read(fileBuffer, 0, fileStat.size, 0);
              } finally {
                await fileHandle.close();
              }
            } catch {
              return false;
            }

            if (isBinaryBuffer(fileBuffer)) {
              return false;
            }

            let textContent: string;
            try {
              const decoder = new TextDecoder("utf-8", { fatal: true });
              textContent = decoder.decode(fileBuffer);
            } catch {
              return false;
            }

            const lines = textContent.split(/\r?\n/);
            for (let i = 0; i < lines.length; i += 1) {
              const line = lines[i] ?? "";
              if (line.includes(input.query)) {
                matches.push({
                  path: relPath,
                  lineNumber: i + 1,
                  line: line.slice(0, MAX_SEARCH_LINE_PREVIEW),
                });
                if (matches.length >= maxResults) {
                  truncated = true;
                  return true;
                }
              }
            }
            return false;
          };

          const targetLstat = await lstat(resolved.operationPath);
          const isTargetSymlink = targetLstat.isSymbolicLink();
          let targetStat = targetLstat;
          if (isTargetSymlink) {
            try {
              targetStat = await stat(resolved.operationPath);
            } catch {
              throw new ToolDomainError(
                "PATH_NOT_FOUND",
                `Symlink target not found for '${relativeTarget}'`,
              );
            }
          }

          if (targetStat.isFile()) {
            await searchFile(
              resolved.operationPath,
              relative(resolved.workspace.root, resolved.operationPath),
            );
          } else if (targetStat.isDirectory()) {
            interface SearchQueueItem {
              operationPath: string;
              canonicalPath: string;
            }

            const queue: SearchQueueItem[] = [
              {
                operationPath: resolved.operationPath,
                canonicalPath: resolved.canonicalPath,
              },
            ];

            while (queue.length > 0 && !truncated) {
              if (context?.signal?.aborted) {
                throw new ToolDomainError(
                  "TIMEOUT",
                  "Search operation was cancelled or timed out",
                );
              }
              const current = queue.shift();
              if (!current) break;

              let dirEntries: Dirent[];
              try {
                dirEntries = await readdir(current.operationPath, {
                  withFileTypes: true,
                });
              } catch {
                continue;
              }

              dirEntries.sort((a, b) => a.name.localeCompare(b.name));

              for (const entry of dirEntries) {
                if (context?.signal?.aborted) {
                  throw new ToolDomainError(
                    "TIMEOUT",
                    "Search operation was cancelled or timed out",
                  );
                }
                const fullEntryPath = join(current.operationPath, entry.name);
                const canonicalEntryPath = join(
                  current.canonicalPath,
                  entry.name,
                );

                if (
                  isDenied(resolved.workspace, fullEntryPath) ||
                  isDenied(resolved.workspace, canonicalEntryPath)
                ) {
                  continue;
                }

                if (entry.isSymbolicLink()) {
                  try {
                    const targetCanonical = await realpath(fullEntryPath);
                    if (
                      !isPathInside(resolved.workspace.root, targetCanonical) ||
                      isDenied(resolved.workspace, targetCanonical)
                    ) {
                      continue;
                    }
                    const s = await stat(fullEntryPath);
                    if (s.isFile()) {
                      const rel = relative(
                        resolved.workspace.root,
                        fullEntryPath,
                      );
                      const shouldStop = await searchFile(fullEntryPath, rel);
                      if (shouldStop) break;
                    }
                  } catch {
                    // ignore unreadable symlink target
                  }
                } else if (entry.isDirectory()) {
                  queue.push({
                    operationPath: fullEntryPath,
                    canonicalPath: canonicalEntryPath,
                  });
                } else if (entry.isFile()) {
                  const rel = relative(resolved.workspace.root, fullEntryPath);
                  const shouldStop = await searchFile(fullEntryPath, rel);
                  if (shouldStop) break;
                }
              }
            }
          }

          const result: FilesystemReadOutput = {
            action: "search",
            query: input.query,
            matches,
            truncated,
          };

          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        }
      }
    },
  };
}
