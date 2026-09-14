import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { toToolErrorResult } from "./errors";
import { type ToolDefinition, ToolRegistry } from "./registry";

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
  register: <TSchema extends z.ZodTypeAny>(
    tool: ToolDefinition<TSchema>,
  ) => void;
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

  const server = new McpServer(serverInfo, {
    capabilities: {
      tools: {
        listChanged: true,
      },
    },
  });

  // Ensure tool request handlers and capabilities are initialized upfront
  // so empty registries can answer tools/list and dynamic registrations work after connect
  // biome-ignore lint/suspicious/noExplicitAny: internal McpServer method
  if (typeof (server as any).setToolRequestHandlers === "function") {
    // biome-ignore lint/suspicious/noExplicitAny: internal McpServer method
    (server as any).setToolRequestHandlers();
  }

  function bindTool<TSchema extends z.ZodTypeAny>(
    tool: ToolDefinition<TSchema>,
  ) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        // biome-ignore lint/suspicious/noExplicitAny: generic boundary with McpServer
        inputSchema: tool.inputSchema as any,
        annotations: tool.annotations,
      },
      // biome-ignore lint/suspicious/noExplicitAny: handler wrapper
      async (args: any, extra: any): Promise<CallToolResult> => {
        try {
          return await tool.handler(args, { extra });
        } catch (error) {
          return toToolErrorResult(error);
        }
      },
    );
  }

  // Bind existing tools in registry
  for (const tool of registry.list()) {
    bindTool(tool);
  }

  const register = <TSchema extends z.ZodTypeAny>(
    tool: ToolDefinition<TSchema>,
  ) => {
    registry.register(tool);
    bindTool(tool);
  };

  return {
    server,
    registry,
    register,
    connect: (transport: Transport) => server.connect(transport),
    close: () => server.close(),
  };
}
