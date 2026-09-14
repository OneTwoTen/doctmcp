import {
  type CallToolResult,
  McpServer,
  type Transport,
} from "@modelcontextprotocol/server";
import { toToolErrorResult } from "./errors";
import { ToolRegistry } from "./registry";

export interface CreateLocalMcpServerOptions {
  registry?: ToolRegistry;
  serverInfo?: {
    name: string;
    version: string;
  };
}

export interface LocalMcpServerInstance {
  server: McpServer;
  registry: ToolRegistry;
  connect: (transport: Transport) => Promise<void>;
  close: () => Promise<void>;
}

export function createLocalMcpServer(
  options: CreateLocalMcpServerOptions = {},
): LocalMcpServerInstance {
  const registry = options.registry ?? new ToolRegistry();
  const serverInfo = options.serverInfo ?? {
    name: "doctmcp-agent",
    version: "0.1.0",
  };

  const server = new McpServer(serverInfo);

  // Register all tools from registry before connecting
  for (const tool of registry.list()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      // biome-ignore lint/suspicious/noExplicitAny: handler wrapper arguments
      async (args: any, extra: any): Promise<CallToolResult> => {
        try {
          return await tool.handler(args, { extra });
        } catch (error) {
          return toToolErrorResult(error);
        }
      },
    );
  }

  return {
    server,
    registry,
    connect: (transport: Transport) => server.connect(transport),
    close: () => server.close(),
  };
}
