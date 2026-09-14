import {
  createLocalToolCatalog,
  type LocalToolCatalogOptions,
} from "./local-tool-catalog";
import {
  createLocalMcpServer,
  type LocalMcpServerInstance,
} from "./server";
import type { WorkspaceRegistry } from "./workspace";

export interface CreateLocalMcpRuntimeOptions extends LocalToolCatalogOptions {
  serverInfo?: {
    name: string;
    version: string;
  };
}

/**
 * Production assembly path cho Local MCP runtime.
 * Transport/bootstrap có thể thay đổi theo milestone, nhưng catalog tool luôn đi qua
 * createLocalToolCatalog() để acceptance test và runtime không đăng ký lệch nhau.
 */
export function createLocalMcpRuntime(
  registry: WorkspaceRegistry,
  options: CreateLocalMcpRuntimeOptions = {},
): LocalMcpServerInstance {
  const { serverInfo, ...catalogOptions } = options;

  return createLocalMcpServer({
    tools: createLocalToolCatalog(registry, catalogOptions),
    ...(serverInfo ? { serverInfo } : {}),
  });
}
