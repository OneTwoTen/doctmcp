import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { DuplicateToolError } from "./errors";
import { type ToolDefinition, ToolRegistry } from "./registry";

// Negative type test: inputSchema is mandatory, omitting it must fail typecheck
// @ts-expect-error inputSchema is required in ToolDefinition
const _invalidToolDefinition: ToolDefinition = {
  name: "missing.schema",
  description: "Tool without inputSchema",
  handler: async () => ({ content: [] }),
};

describe("ToolRegistry", () => {
  test("registers a tool and retrieves it", () => {
    const registry = new ToolRegistry();
    const tool = {
      name: "system.info",
      description: "Get system info",
      inputSchema: z.object({}),
      handler: async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }),
    };

    registry.register(tool);

    expect(registry.has("system.info")).toBe(true);
    expect(registry.get("system.info")?.description).toBe("Get system info");
    expect(registry.list().length).toBe(1);
  });

  test("rejects registering duplicate tool names", () => {
    const registry = new ToolRegistry();
    const tool = {
      name: "workspace.list",
      description: "List workspaces",
      inputSchema: z.object({}),
      handler: async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }),
    };

    registry.register(tool);

    expect(() => {
      registry.register({
        ...tool,
        description: "Duplicate tool",
      });
    }).toThrow(DuplicateToolError);
  });

  test("starts empty and lists all registered tools", () => {
    const registry = new ToolRegistry();
    expect(registry.size).toBe(0);
    expect(registry.list()).toEqual([]);

    registry.register({
      name: "tool-a",
      description: "Tool A",
      inputSchema: z.object({}),
      handler: async () => ({ content: [] }),
    });

    registry.register({
      name: "tool-b",
      description: "Tool B",
      inputSchema: z.object({}),
      handler: async () => ({ content: [] }),
    });

    expect(registry.size).toBe(2);
    expect(registry.list().map((t) => t.name)).toEqual(["tool-a", "tool-b"]);
  });
});
