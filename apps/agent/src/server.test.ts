import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { ToolDomainError } from "./errors";
import { ToolRegistry } from "./registry";
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

    const capabilities = activeHarness.client.getServerCapabilities();
    expect(capabilities).toBeDefined();
    expect(capabilities?.tools).toBeDefined();
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

    let unknownToolFailed = false;
    try {
      const result = await activeHarness.client.callTool({
        name: "non.existent.tool",
        arguments: {},
      });
      // If client returns isError: true instead of throwing
      expect(result.isError).toBe(true);
      unknownToolFailed = true;
    } catch (error) {
      expect(error).toBeDefined();
      unknownToolFailed = true;
    }
    expect(unknownToolFailed).toBe(true);

    // Server should still be healthy and responsive to next call
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

  test("allows registering tools on server instance directly", async () => {
    activeHarness = await createMcpTestHarness();

    activeHarness.serverInstance.register({
      name: "dynamic.tool",
      description: "Dynamically added tool",
      inputSchema: z.object({}),
      handler: async () => ({
        content: [{ type: "text", text: "dynamic-ok" }],
      }),
    });

    const toolsResult = await activeHarness.client.listTools();
    expect(toolsResult.tools.some((t) => t.name === "dynamic.tool")).toBe(true);

    const callResult = await activeHarness.client.callTool({
      name: "dynamic.tool",
      arguments: {},
    });
    expect(getFirstTextContent(callResult)).toBe("dynamic-ok");
  });
});
