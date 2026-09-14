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
  tools?: ToolDefinition[];
  registry?: ToolRegistry;
  serverInfo?: {
    name: string;
    version: string;
  };
}

export interface LocalMcpServerInstance {
  register: <
    TInputSchema extends z.ZodTypeAny = z.ZodTypeAny,
    TOutputSchema extends z.ZodTypeAny = z.ZodTypeAny,
  >(
    tool: ToolDefinition<TInputSchema, TOutputSchema>,
  ) => void;
  getTool: (name: string) => Readonly<ToolDefinition> | undefined;
  hasTool: (name: string) => boolean;
  listTools: () => readonly Readonly<ToolDefinition>[];
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
    // Chặn trùng tên tool đồng thời lưu lại snapshot bất biến trong registry
    const frozenTool = registry.register(tool);
    const handler = frozenTool.handler;

    server.registerTool(
      frozenTool.name,
      {
        title: frozenTool.title,
        description: frozenTool.description,
        // biome-ignore lint/suspicious/noExplicitAny: SDK v2 registerTool overload schema resolution
        inputSchema: frozenTool.inputSchema as any,
        // biome-ignore lint/suspicious/noExplicitAny: SDK v2 registerTool overload schema resolution
        outputSchema: frozenTool.outputSchema as any,
        annotations: frozenTool.annotations,
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
          return await handler(args, toolContext);
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
