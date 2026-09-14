import {
  type CallToolResult,
  McpServer,
  type ServerContext,
  type Transport,
} from "@modelcontextprotocol/server";
import type { z } from "zod";
import { ServerAlreadyConnectedError, toToolErrorResult } from "./errors";
import {
  type ToolContext,
  type ToolDefinition,
  ToolRegistry,
} from "./registry";

export interface CreateLocalMcpServerOptions {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool collection
  tools?: ToolDefinition<any, any>[];
  registry?: ToolRegistry;
  serverInfo?: {
    name: string;
    version: string;
  };
}

export interface LocalMcpServerInstance {
  server: McpServer;
  register: <
    TInputSchema extends z.ZodTypeAny = z.ZodTypeAny,
    TOutputSchema extends z.ZodTypeAny = z.ZodTypeAny,
  >(
    tool: ToolDefinition<TInputSchema, TOutputSchema>,
  ) => void;
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool lookup
  getTool: (name: string) => ToolDefinition<any, any> | undefined;
  hasTool: (name: string) => boolean;
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tools collection
  listTools: () => ToolDefinition<any, any>[];
  connect: (transport: Transport) => Promise<void>;
  close: () => Promise<void>;
  readonly isConnected: boolean;
}

export function createLocalMcpServer(
  options: CreateLocalMcpServerOptions = {},
): LocalMcpServerInstance {
  const registry = new ToolRegistry();
  const serverInfo = options.serverInfo ?? {
    name: "doctmcp-agent",
    version: "0.1.0",
  };

  const server = new McpServer(serverInfo);
  let connected = false;

  const register = <
    TInputSchema extends z.ZodTypeAny = z.ZodTypeAny,
    TOutputSchema extends z.ZodTypeAny = z.ZodTypeAny,
  >(
    tool: ToolDefinition<TInputSchema, TOutputSchema>,
  ): void => {
    if (connected) {
      throw new ServerAlreadyConnectedError();
    }
    // Chặn trùng tên tool đồng thời lưu lại snapshot trong registry
    registry.register(tool);

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        // biome-ignore lint/suspicious/noExplicitAny: SDK v2 registerTool overload schema resolution
        inputSchema: tool.inputSchema as any,
        // biome-ignore lint/suspicious/noExplicitAny: SDK v2 registerTool overload schema resolution
        outputSchema: tool.outputSchema as any,
        annotations: tool.annotations,
      },
      // biome-ignore lint/suspicious/noExplicitAny: handler wrapper arguments
      async (args: any, ctx: ServerContext): Promise<CallToolResult> => {
        try {
          const toolContext: ToolContext = {
            signal: ctx.mcpReq.signal,
            requestId: ctx.mcpReq.id,
            sessionId: ctx.sessionId,
            meta: ctx.mcpReq._meta,
            extra: ctx,
          };
          return await tool.handler(args, toolContext);
        } catch (error) {
          return toToolErrorResult(error);
        }
      },
    );
  };

  if (options.registry) {
    for (const tool of options.registry.list()) {
      register(tool);
    }
  }

  if (options.tools) {
    for (const tool of options.tools) {
      register(tool);
    }
  }

  return {
    server,
    register,
    getTool: (name: string) => registry.get(name),
    hasTool: (name: string) => registry.has(name),
    listTools: () => registry.list(),
    get isConnected() {
      return connected;
    },
    connect: async (transport: Transport) => {
      await server.connect(transport);
      connected = true;
    },
    close: async () => {
      await server.close();
      connected = false;
    },
  };
}
