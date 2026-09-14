import { createFilesystemDeleteTool } from "./filesystem-delete";
import { createFilesystemReadTool } from "./filesystem-read";
import {
  createFilesystemWriteTool,
  DEFAULT_MAX_WRITE_BYTES,
} from "./filesystem-write";
import type { ToolDefinition } from "./registry";
import { createShellExecTool, type ShellExecToolOptions } from "./shell-exec";
import { createSystemTool } from "./system";
import {
  createWorkspaceTool,
  WorkspacePathResolver,
  type WorkspaceRegistry,
} from "./workspace";

export interface LocalToolCatalogOptions {
  maxWriteBytes?: number;
  shellExec?: ShellExecToolOptions;
}

/**
 * Canonical registration path cho toàn bộ local MCP tool catalog.
 * Acceptance test và runtime phải dùng factory này để tránh drift tên/schema/risk metadata.
 */
export function createLocalToolCatalog(
  registry: WorkspaceRegistry,
  options: LocalToolCatalogOptions = {},
): ToolDefinition[] {
  const resolver = new WorkspacePathResolver(registry);

  return [
    createWorkspaceTool(registry),
    createSystemTool(),
    createFilesystemReadTool(resolver),
    createFilesystemWriteTool(
      resolver,
      options.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES,
    ),
    createFilesystemDeleteTool(registry),
    createShellExecTool(registry, options.shellExec),
  ];
}
