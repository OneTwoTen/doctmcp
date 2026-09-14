import { describe, expect, test } from "bun:test";
import { basename } from "node:path";
import { createSystemTool } from "./system";
import { createMcpTestHarness } from "./test-harness";

describe("system tool", () => {
  test("exposes info and which through MCP with read-only annotations", async () => {
    const harness = await createMcpTestHarness({ tools: [createSystemTool()] });
    try {
      const tools = await harness.client.listTools();
      const tool = tools.tools.find((entry) => entry.name === "system");
      expect(tool).toBeDefined();
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });

      const info = await harness.client.callTool({
        name: "system",
        arguments: { action: "info" },
      });
      expect(info.isError).toBeFalsy();
      expect(info.structuredContent).toMatchObject({
        platform: process.platform,
        arch: process.arch,
        runtime: { name: "bun" },
      });
      expect(info.structuredContent).not.toHaveProperty("env");
      expect(info.structuredContent).not.toHaveProperty("network");

      const which = await harness.client.callTool({
        name: "system",
        arguments: { action: "which", command: process.execPath },
      });
      expect(which.isError).toBeFalsy();
      expect(which.structuredContent).toEqual({
        found: true,
        path: process.execPath,
      });
    } finally {
      await harness.close();
    }
  });

  test("resolves a command name from PATH without executing it", async () => {
    const harness = await createMcpTestHarness({ tools: [createSystemTool()] });
    try {
      const command = basename(process.execPath);
      const result = await harness.client.callTool({
        name: "system",
        arguments: { action: "which", command },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ found: true });
    } finally {
      await harness.close();
    }
  });

  test("returns found:false for an absent executable", async () => {
    const harness = await createMcpTestHarness({ tools: [createSystemTool()] });
    try {
      const result = await harness.client.callTool({
        name: "system",
        arguments: {
          action: "which",
          command: "doctmcp-command-that-does-not-exist-9f4a7e",
        },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ found: false });
    } finally {
      await harness.close();
    }
  });

  test("rejects empty, invalid, and unknown action input", async () => {
    const harness = await createMcpTestHarness({ tools: [createSystemTool()] });
    try {
      for (const arguments_ of [
        { action: "which", command: "   " },
        { action: "which", command: "bad\0command" },
        { action: "info", extra: true },
        { action: "unknown" },
      ]) {
        const result = await harness.client.callTool({
          name: "system",
          arguments: arguments_,
        });
        expect(result.isError).toBe(true);
      }
    } finally {
      await harness.close();
    }
  });
});
