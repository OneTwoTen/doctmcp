import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createSystemTool, resolveExecutable } from "./system";
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

  test("supports POSIX and Windows PATH/PATHEXT resolution", async () => {
    const cases = [
      {
        options: {
          platform: "linux" as const,
          pathValue: "/usr/local/bin:/usr/bin",
          isFile: async (candidate: string) => candidate === "/usr/bin/bun",
          canonicalize: async (candidate: string) => candidate,
        },
        expected: "/usr/bin/bun",
      },
      {
        options: {
          platform: "darwin" as const,
          pathValue: "/opt/homebrew/bin:/usr/bin",
          isFile: async (candidate: string) =>
            candidate === "/opt/homebrew/bin/bun",
          canonicalize: async (candidate: string) => candidate,
        },
        expected: "/opt/homebrew/bin/bun",
      },
      {
        options: {
          platform: "win32" as const,
          pathValue: "C:\\Tools;C:\\Windows\\System32",
          pathExt: ".EXE;.CMD",
          isFile: async (candidate: string) =>
            candidate === "C:\\Tools\\bun.EXE",
          canonicalize: async (candidate: string) => candidate,
        },
        expected: "C:\\Tools\\bun.EXE",
      },
    ];

    for (const testCase of cases) {
      await expect(resolveExecutable("bun", testCase.options)).resolves.toBe(
        testCase.expected,
      );
    }

    const windowsOptions = {
      platform: "win32" as const,
      pathValue: "C:\\Tools",
      pathExt: ".EXE;.CMD",
      isFile: async (candidate: string) =>
        [
          "C:\\Tools\\bun",
          "C:\\Tools\\bun.EXE",
          "C:\\Tools\\foo.txt.EXE",
        ].includes(candidate),
      canonicalize: async (candidate: string) => candidate,
    };
    await expect(resolveExecutable("bun", windowsOptions)).resolves.toBe(
      "C:\\Tools\\bun.EXE",
    );
    await expect(
      resolveExecutable("foo.txt", windowsOptions),
    ).resolves.toBeUndefined();
  });

  test("rejects directories but accepts symlinks to executable files", async () => {
    const root = await mkdtemp(join(tmpdir(), "doctmcp-system-"));
    try {
      const directory = join(root, "fake-command");
      const executable = join(root, "real-command");
      const link = join(root, "linked-command");
      await mkdir(directory);
      await writeFile(executable, "#!/bin/sh\nexit 0\n");
      await chmod(executable, 0o755);
      try {
        await symlink(executable, link);
      } catch {
        return;
      }

      expect((await stat(directory)).isDirectory()).toBe(true);
      await expect(
        resolveExecutable("fake-command", { pathValue: root }),
      ).resolves.toBeUndefined();
      await expect(
        resolveExecutable("linked-command", { pathValue: root }),
      ).resolves.toBe(await realpath(executable));
      await expect(resolveExecutable(executable)).resolves.toBe(
        await realpath(executable),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
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
