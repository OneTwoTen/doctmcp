import { afterEach, describe, expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  DuplicateToolError,
  ServerAlreadyConnectedError,
  ToolDomainError,
} from "./errors";
import { ToolRegistry } from "./registry";
import { createLocalMcpServer } from "./server";
import { createMcpTestHarness, type McpTestHarness } from "./test-harness";

function getFirstTextContent(result: unknown): string {
  if (
    typeof result !== "object" ||
    result === null ||
    !("content" in result) ||
    !Array.isArray(result.content) ||
    result.content.length === 0
  ) {
    throw new Error("Expected result to have content array");
  }
  const first = result.content[0];
  if (
    typeof first === "object" &&
    first !== null &&
    "text" in first &&
    typeof first.text === "string"
  ) {
    return first.text;
  }
  throw new Error("Expected text in content[0]");
}

describe("Local MCP Server", () => {
  let activeHarness: McpTestHarness | null = null;

  afterEach(async () => {
    if (activeHarness) {
      await activeHarness.close();
      activeHarness = null;
    }
  });

  test("initializes local MCP server successfully with MCP client", async () => {
    activeHarness = await createMcpTestHarness();

    const serverVersion = activeHarness.client.getServerVersion();
    expect(serverVersion).toBeDefined();
    expect(serverVersion?.name).toBe("doctmcp-agent");
    expect(serverVersion?.version).toBe("0.1.0");
  });

  test("returns valid empty tools list for empty registry", async () => {
    activeHarness = await createMcpTestHarness();

    const toolsResult = await activeHarness.client.listTools();
    expect(toolsResult.tools).toBeArray();
    expect(toolsResult.tools.length).toBe(0);
  });

  test("returns valid tools list with schemas and annotations for registered tools", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "system.info",
      description: "Get basic system information",
      inputSchema: z.object({
        verbose: z.boolean().optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      handler: async (args) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              os: "darwin",
              verbose: args.verbose ?? false,
            }),
          },
        ],
      }),
    });

    activeHarness = await createMcpTestHarness({ registry });

    const toolsResult = await activeHarness.client.listTools();
    expect(toolsResult.tools.length).toBe(1);

    const tool = toolsResult.tools[0];
    expect(tool).toBeDefined();
    if (!tool) throw new Error("Expected tool to be defined");

    expect(tool.name).toBe("system.info");
    expect(tool.description).toBe("Get basic system information");
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.annotations?.destructiveHint).toBe(false);
  });

  test("executes tool call successfully through MCP protocol", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "smoke.echo",
      description: "Echo message back",
      inputSchema: z.object({
        message: z.string(),
      }),
      handler: async (args) => ({
        content: [{ type: "text", text: `echo:${args.message}` }],
      }),
    });

    activeHarness = await createMcpTestHarness({ registry });

    const callResult = await activeHarness.client.callTool({
      name: "smoke.echo",
      arguments: { message: "hello-mcp" },
    });

    expect(callResult.isError).toBeFalsy();
    expect(getFirstTextContent(callResult)).toBe("echo:hello-mcp");
  });

  test("supports tool outputSchema and structuredContent", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "math.add",
      description: "Add two numbers",
      inputSchema: z.object({
        a: z.number(),
        b: z.number(),
      }),
      outputSchema: z.object({
        result: z.number(),
      }),
      handler: async ({ a, b }) => ({
        content: [{ type: "text", text: `result: ${a + b}` }],
        structuredContent: { result: a + b },
      }),
    });

    activeHarness = await createMcpTestHarness({ registry });

    const toolsResult = await activeHarness.client.listTools();
    const tool = toolsResult.tools.find((t) => t.name === "math.add");
    expect(tool).toBeDefined();
    expect(tool?.outputSchema).toBeDefined();

    const callResult = await activeHarness.client.callTool({
      name: "math.add",
      arguments: { a: 10, b: 20 },
    });
    expect(callResult.isError).toBeFalsy();
    expect(getFirstTextContent(callResult)).toBe("result: 30");
    expect(callResult.structuredContent).toEqual({ result: 30 });
  });

  test("unknown tool call returns error and does not crash the server", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "smoke.ping",
      description: "Ping",
      inputSchema: z.object({}),
      handler: async () => ({
        content: [{ type: "text", text: "pong" }],
      }),
    });

    activeHarness = await createMcpTestHarness({ registry });

    // Calling unknown tool must reject with an error
    await expect(
      activeHarness.client.callTool({
        name: "non.existent.tool",
        arguments: {},
      }),
    ).rejects.toThrow();

    // Server should still be healthy and responsive to subsequent valid calls
    const subsequentResult = await activeHarness.client.callTool({
      name: "smoke.ping",
      arguments: {},
    });
    expect(subsequentResult.isError).toBeFalsy();
    expect(getFirstTextContent(subsequentResult)).toBe("pong");
  });

  test("maps ToolDomainError to structured error result with isError: true", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "workspace.get",
      description: "Get workspace details",
      inputSchema: z.object({
        id: z.string(),
      }),
      handler: async (args) => {
        throw new ToolDomainError(
          "WORKSPACE_NOT_FOUND",
          `Workspace '${args.id}' does not exist`,
          { requestedId: args.id },
        );
      },
    });

    activeHarness = await createMcpTestHarness({ registry });

    const result = await activeHarness.client.callTool({
      name: "workspace.get",
      arguments: { id: "unknown-ws" },
    });

    expect(result.isError).toBe(true);
    const errorText = getFirstTextContent(result);
    const parsed = JSON.parse(errorText);
    expect(parsed.code).toBe("WORKSPACE_NOT_FOUND");
    expect(parsed.message).toBe("Workspace 'unknown-ws' does not exist");
    expect(parsed.details).toEqual({ requestedId: "unknown-ws" });
  });

  test("sanitizes unexpected internal errors to avoid leaking local system details", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "crash.demo",
      description: "Crash with sensitive local info",
      inputSchema: z.object({}),
      handler: async () => {
        throw new Error("Sensitive path leak: /Users/admin/.secret/keys.json");
      },
    });

    activeHarness = await createMcpTestHarness({ registry });

    const result = await activeHarness.client.callTool({
      name: "crash.demo",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(getFirstTextContent(result));
    expect(parsed.code).toBe("INTERNAL_ERROR");
    expect(parsed.message).toBe("Internal error");
    expect(getFirstTextContent(result)).not.toContain("/Users/admin");
  });

  test("regression: tool with inputSchema z.object({}) receives empty object args, not MCP context", async () => {
    let capturedArgs: unknown = null;
    let capturedSignal: AbortSignal | null = null;
    let capturedRequestId: unknown = null;

    const serverInstance = createLocalMcpServer();
    serverInstance.register({
      name: "smoke.schemaless",
      description: "Tool without arguments",
      inputSchema: z.object({}),
      handler: async (args, context) => {
        capturedArgs = args;
        capturedSignal = context.signal;
        capturedRequestId = context.requestId;
        return {
          content: [{ type: "text", text: "ok" }],
        };
      },
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await serverInstance.connect(serverTransport);

    const { Client } = await import("@modelcontextprotocol/client");
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "smoke.schemaless",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    expect(getFirstTextContent(result)).toBe("ok");

    // Regression assertions:
    // args must be empty object, NOT ServerContext
    expect(capturedArgs).toEqual({});
    expect(capturedArgs).not.toHaveProperty("mcpReq");
    expect(capturedArgs).not.toHaveProperty("sessionId");

    // context must have typed signal and requestId
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedRequestId).toBeDefined();

    await client.close();
    await serverInstance.close();
  });

  test("serverInstance.register() binds tools before connect and exposes read-only accessors", async () => {
    const serverInstance = createLocalMcpServer();
    expect(serverInstance.isConnected).toBe(false);
    expect(serverInstance.listTools()).toHaveLength(0);

    serverInstance.register({
      name: "tool.sample",
      description: "Sample tool",
      inputSchema: z.object({ val: z.string() }),
      handler: async ({ val }) => ({
        content: [{ type: "text", text: `val:${val}` }],
      }),
    });

    expect(serverInstance.hasTool("tool.sample")).toBe(true);
    expect(serverInstance.getTool("tool.sample")?.description).toBe(
      "Sample tool",
    );
    expect(serverInstance.listTools()).toHaveLength(1);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await serverInstance.connect(serverTransport);
    expect(serverInstance.isConnected).toBe(true);

    const { Client } = await import("@modelcontextprotocol/client");
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    const toolsResult = await client.listTools();
    expect(toolsResult.tools.map((t) => t.name)).toContain("tool.sample");

    const callResult = await client.callTool({
      name: "tool.sample",
      arguments: { val: "tested" },
    });
    expect(getFirstTextContent(callResult)).toBe("val:tested");

    await client.close();
    await serverInstance.close();
  });

  test("serverInstance.register() rejects duplicate tool names", () => {
    const serverInstance = createLocalMcpServer();
    const tool = {
      name: "tool.duplicate",
      description: "Tool",
      inputSchema: z.object({}),
      handler: async () => ({ content: [] }),
    };

    serverInstance.register(tool);
    expect(() => serverInstance.register(tool)).toThrow(DuplicateToolError);
  });

  test("serverInstance.register() rejects registration after server is connected", async () => {
    const serverInstance = createLocalMcpServer();
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    await serverInstance.connect(serverTransport);

    expect(() => {
      serverInstance.register({
        name: "tool.late",
        description: "Late registration",
        inputSchema: z.object({}),
        handler: async () => ({ content: [] }),
      });
    }).toThrow(ServerAlreadyConnectedError);

    await serverInstance.close();
  });

  test("does not expose raw McpServer instance on LocalMcpServerInstance", () => {
    const serverInstance = createLocalMcpServer();
    expect("server" in serverInstance).toBe(false);
    // @ts-expect-error server must not be exposed on LocalMcpServerInstance
    const _rawServer = serverInstance.server;
  });

  test("freezes tool definitions and prevents mutation of registered handlers", async () => {
    const mutableTool = {
      name: "tool.immutable",
      description: "Immutable test",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
      handler: async () => ({
        content: [{ type: "text" as const, text: "original" }],
      }),
    };

    const serverInstance = createLocalMcpServer();
    serverInstance.register(mutableTool);

    // 1. Tool returned by getTool() and listTools() is frozen
    const retrievedTool = serverInstance.getTool("tool.immutable");
    expect(retrievedTool).toBeDefined();
    expect(Object.isFrozen(retrievedTool)).toBe(true);
    expect(Object.isFrozen(retrievedTool?.annotations)).toBe(true);
    expect(Object.isFrozen(serverInstance.listTools())).toBe(true);

    // 2. Modifying returned tool throws TypeError in strict mode
    expect(() => {
      // @ts-expect-error property is read-only
      retrievedTool.description = "modified";
    }).toThrow(TypeError);

    // 3. Modifying original caller tool object does not affect registered tool handler
    mutableTool.handler = async () => ({
      content: [{ type: "text" as const, text: "mutated" }],
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await serverInstance.connect(serverTransport);

    const { Client } = await import("@modelcontextprotocol/client");
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    const callResult = await client.callTool({
      name: "tool.immutable",
      arguments: {},
    });
    expect(getFirstTextContent(callResult)).toBe("original");

    await client.close();
    await serverInstance.close();
  });
});
