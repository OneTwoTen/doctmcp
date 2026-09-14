import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { z } from "zod";
import { ToolDomainError } from "./errors";
import type { ToolDefinition } from "./registry";

export const workspaceCapabilities = [
  "read",
  "write",
  "delete",
  "execute",
] as const;
export type WorkspaceCapability = (typeof workspaceCapabilities)[number];

export interface WorkspaceCapabilities {
  readonly read?: boolean;
  readonly write?: boolean;
  readonly delete?: boolean;
  readonly execute?: boolean;
}

export interface WorkspaceConfig {
  id: string;
  name: string;
  root: string;
  capabilities: WorkspaceCapabilities;
  deny?: string[];
}

export interface WorkspaceMetadata {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly capabilities: Readonly<Required<WorkspaceCapabilities>>;
  readonly deny: readonly string[];
}

function invalidConfig(message: string): ToolDomainError {
  return new ToolDomainError("INVALID_INPUT", message);
}

function isPathInside(root: string, target: string): boolean {
  const child = relative(root, target);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

function rejectUnsafeRelativePath(path: string): void {
  if (!path || isAbsolute(path) || win32.isAbsolute(path)) {
    throw new ToolDomainError(
      "PATH_OUTSIDE_WORKSPACE",
      "Path must be a non-empty relative path",
    );
  }
  const segments = path.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new ToolDomainError(
      "PATH_OUTSIDE_WORKSPACE",
      "Path traversal is not allowed",
    );
  }
}

async function canonicalizeRoot(root: string): Promise<string> {
  try {
    return await realpath(resolve(root));
  } catch {
    throw new ToolDomainError(
      "PATH_NOT_FOUND",
      "Workspace root does not exist",
    );
  }
}

async function canonicalizeTarget(
  root: string,
  operationPath: string,
): Promise<{ canonicalPath: string; exists: boolean }> {
  try {
    const canonicalPath = await realpath(operationPath);
    return { canonicalPath, exists: true };
  } catch {
    let candidate = operationPath;
    const missing: string[] = [];
    while (true) {
      try {
        const existing = await realpath(candidate);
        return {
          canonicalPath: join(existing, ...missing.reverse()),
          exists: false,
        };
      } catch {
        const parent = resolve(candidate, "..");
        if (parent === candidate || !isPathInside(root, parent)) {
          throw new ToolDomainError(
            "PATH_OUTSIDE_WORKSPACE",
            "Path cannot be resolved safely",
          );
        }
        missing.push(candidate.slice(parent.length + 1));
        candidate = parent;
      }
    }
  }
}

export class WorkspaceRegistry {
  private constructor(
    private readonly workspaces: readonly WorkspaceMetadata[],
  ) {}

  static async create(
    configs: readonly WorkspaceConfig[],
  ): Promise<WorkspaceRegistry> {
    const ids = new Set<string>();
    const workspaces: WorkspaceMetadata[] = [];
    for (const config of configs) {
      if (!config.id || ids.has(config.id) || !config.name) {
        throw invalidConfig(
          "Workspace id and name must be unique and non-empty",
        );
      }
      ids.add(config.id);
      const root = await canonicalizeRoot(config.root);
      const deny: string[] = [];
      for (const denyPath of config.deny ?? []) {
        rejectUnsafeRelativePath(denyPath);
        const canonicalDeny = await canonicalizeTarget(
          root,
          join(root, denyPath),
        );
        if (!isPathInside(root, canonicalDeny.canonicalPath)) {
          throw new ToolDomainError(
            "PATH_OUTSIDE_WORKSPACE",
            "Deny path is outside workspace",
          );
        }
        deny.push(relative(root, canonicalDeny.canonicalPath));
      }
      const capabilities = Object.freeze({
        read: config.capabilities.read === true,
        write: config.capabilities.write === true,
        delete: config.capabilities.delete === true,
        execute: config.capabilities.execute === true,
      });
      workspaces.push(
        Object.freeze({
          id: config.id,
          name: config.name,
          root,
          capabilities,
          deny: Object.freeze([...deny]),
        }),
      );
    }
    for (let index = 0; index < workspaces.length; index += 1) {
      const workspace = workspaces[index];
      if (!workspace) continue;
      for (
        let otherIndex = index + 1;
        otherIndex < workspaces.length;
        otherIndex += 1
      ) {
        const other = workspaces[otherIndex];
        if (
          other &&
          (isPathInside(workspace.root, other.root) ||
            isPathInside(other.root, workspace.root))
        ) {
          throw invalidConfig("Workspace roots must not overlap");
        }
      }
    }
    return new WorkspaceRegistry(Object.freeze(workspaces));
  }

  list(): readonly WorkspaceMetadata[] {
    return this.workspaces;
  }

  get(id: string): WorkspaceMetadata | undefined {
    return this.workspaces.find((workspace) => workspace.id === id);
  }
}

export interface ResolvedWorkspacePath {
  readonly workspace: WorkspaceMetadata;
  /** Absolute lexical path that the filesystem operation must use. */
  readonly operationPath: string;
  /** Canonical path used only for containment and permission checks. */
  readonly canonicalPath: string;
  readonly exists: boolean;
}

export class WorkspacePathResolver {
  constructor(private readonly registry: WorkspaceRegistry) {}

  async resolve(
    workspaceId: string,
    path: string,
    capability?: WorkspaceCapability,
  ): Promise<ResolvedWorkspacePath> {
    const workspace = this.registry.get(workspaceId);
    if (!workspace) {
      throw new ToolDomainError(
        "WORKSPACE_NOT_FOUND",
        `Workspace '${workspaceId}' does not exist`,
      );
    }
    rejectUnsafeRelativePath(path);
    const operationPath = resolve(join(workspace.root, path));
    const target = await canonicalizeTarget(workspace.root, operationPath);
    const canonicalInsideWorkspace = isPathInside(
      workspace.root,
      target.canonicalPath,
    );
    let finalEntryIsSymlink = false;
    if (capability === "delete") {
      try {
        finalEntryIsSymlink = (await lstat(operationPath)).isSymbolicLink();
      } catch {
        // A missing path is handled by the caller that performs the operation.
      }
    }
    const mayUnlinkOutsideSymlink =
      capability === "delete" &&
      finalEntryIsSymlink &&
      isPathInside(workspace.root, operationPath);
    if (!canonicalInsideWorkspace && !mayUnlinkOutsideSymlink) {
      throw new ToolDomainError(
        "PATH_OUTSIDE_WORKSPACE",
        "Path resolves outside workspace",
      );
    }
    if (capability === "delete" && operationPath === workspace.root) {
      throw new ToolDomainError(
        "PERMISSION_DENIED",
        "Workspace root cannot be deleted",
      );
    }
    const denied = workspace.deny.some(
      (denyPath) =>
        isPathInside(join(workspace.root, denyPath), operationPath) ||
        isPathInside(join(workspace.root, denyPath), target.canonicalPath),
    );
    if (denied) {
      throw new ToolDomainError(
        "PERMISSION_DENIED",
        "Path is denied by workspace policy",
      );
    }
    if (capability && workspace.capabilities[capability] !== true) {
      throw new ToolDomainError(
        "PERMISSION_DENIED",
        `Capability '${capability}' is not enabled`,
      );
    }
    return {
      workspace,
      operationPath,
      canonicalPath: target.canonicalPath,
      exists: target.exists,
    };
  }
}

export class PermissionChecker {
  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly resolver = new WorkspacePathResolver(registry),
  ) {}

  async assertPath(
    workspaceId: string,
    path: string,
    capability: WorkspaceCapability,
  ): Promise<ResolvedWorkspacePath> {
    return this.resolver.resolve(workspaceId, path, capability);
  }

  assertWorkspace(
    workspaceId: string,
    capability: WorkspaceCapability,
  ): WorkspaceMetadata {
    const workspace = this.registry.get(workspaceId);
    if (!workspace) {
      throw new ToolDomainError(
        "WORKSPACE_NOT_FOUND",
        `Workspace '${workspaceId}' does not exist`,
      );
    }
    if (workspace.capabilities[capability] !== true) {
      throw new ToolDomainError(
        "PERMISSION_DENIED",
        `Capability '${capability}' is not enabled`,
      );
    }
    return workspace;
  }
}

const workspaceInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("get"), workspace: z.string().min(1) }).strict(),
]);
const workspaceOutput = z.object({
  workspaces: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        root: z.string(),
        capabilities: z.object({
          read: z.boolean(),
          write: z.boolean(),
          delete: z.boolean(),
          execute: z.boolean(),
        }),
        deny: z.array(z.string()),
      }),
    )
    .optional(),
  workspace: z
    .object({
      id: z.string(),
      name: z.string(),
      root: z.string(),
      capabilities: z.object({
        read: z.boolean(),
        write: z.boolean(),
        delete: z.boolean(),
        execute: z.boolean(),
      }),
      deny: z.array(z.string()),
    })
    .optional(),
});

export function createWorkspaceTool(
  registry: WorkspaceRegistry,
): ToolDefinition<typeof workspaceInput, typeof workspaceOutput> {
  return {
    name: "workspace",
    description: "List and inspect configured local workspaces",
    inputSchema: workspaceInput,
    outputSchema: workspaceOutput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (input) => {
      if (input.action === "list") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ workspaces: registry.list() }),
            },
          ],
          structuredContent: { workspaces: registry.list() },
        };
      }
      const workspace = registry.get(input.workspace);
      if (!workspace) {
        throw new ToolDomainError(
          "WORKSPACE_NOT_FOUND",
          `Workspace '${input.workspace}' does not exist`,
        );
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ workspace }) }],
        structuredContent: { workspace },
      };
    },
  };
}

export { isPathInside };
