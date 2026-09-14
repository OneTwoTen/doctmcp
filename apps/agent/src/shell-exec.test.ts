import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createShellExecTool, type ShellExecToolOptions } from "./shell-exec";
import { createMcpTestHarness } from "./test-harness";
import { type WorkspaceCapabilities, WorkspaceRegistry } from "./workspace";

describe("shell.exec", () => {
  const roots: string[] = [];
  const harnesses: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function setup(
    capabilities: WorkspaceCapabilities = { execute: true },
    options: ShellExecToolOptions = {},
    deny?: string[],
  ) {
    const root = await mkdtemp(join(tmpdir(), "doctmcp-shell-tool-"));
    roots.push(root);
    const registry = await WorkspaceRegistry.create([
      {
        id: "project",
        name: "Project",
        root,
        capabilities,
        deny,
      },
    ]);
    const harness = await createMcpTestHarness({
      tools: [createShellExecTool(registry, options)],
    });
    harnesses.push(harness);
    return { root, harness };
  }

  function errorCode(result: {
    content: Array<{ type: string; text?: string }>;
  }) {
    const first = result.content[0];
    if (first?.type !== "text" || !first.text) {
      throw new Error("Expected structured text error");
    }
    return JSON.parse(first.text).code;
  }

  test("executes a command through MCP with conservative annotations", async () => {
    const { harness } = await setup();
    const tools = await harness.client.listTools();
    const tool = tools.tools.find((entry) => entry.name === "shell.exec");
    expect(tool).toBeDefined();
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });

    const result = await harness.client.callTool({
      name: "shell.exec",
      arguments: {
        workspace: "project",
        command: process.execPath,
        args: ["-e", 'console.log("hello from shell.exec")'],
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      exitCode: 0,
      signal: null,
      stdout: "hello from shell.exec\n",
      stderr: "",
      truncated: false,
    });
    expect(
      (result.structuredContent as { durationMs: number }).durationMs,
    ).toBeGreaterThanOrEqual(0);
  });

  test("returns non-zero exit code and stderr as a process result", async () => {
    const { harness } = await setup();
    const result = await harness.client.callTool({
      name: "shell.exec",
      arguments: {
        workspace: "project",
        command: process.execPath,
        args: ["-e", 'console.error("expected failure"); process.exit(7)'],
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      exitCode: 7,
      stderr: "expected failure\n",
      truncated: false,
    });
  });

  test("returns a structured error when command does not exist", async () => {
    const { harness } = await setup();
    const result = await harness.client.callTool({
      name: "shell.exec",
      arguments: {
        workspace: "project",
        command: "doctmcp-command-that-does-not-exist-9f4a7e",
      },
    });

    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("PROCESS_FAILED");
  });

  test("resolves cwd inside the workspace", async () => {
    const { root, harness } = await setup();
    const nested = join(root, "nested");
    await mkdir(nested);

    const result = await harness.client.callTool({
      name: "shell.exec",
      arguments: {
        workspace: "project",
        command: process.execPath,
        args: ["-e", "console.log(process.cwd())"],
        cwd: "nested",
      },
    });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { stdout: string }).stdout.trim()).toBe(
      nested,
    );
  });

  test("rejects cwd traversal, missing directories, files, and symlink escape", async () => {
    const { root, harness } = await setup();
    await writeFile(join(root, "file.txt"), "not a directory");

    for (const [cwd, expectedCode] of [
      ["../outside", "PATH_OUTSIDE_WORKSPACE"],
      ["missing", "PATH_NOT_FOUND"],
      ["file.txt", "INVALID_INPUT"],
    ]) {
      const result = await harness.client.callTool({
        name: "shell.exec",
        arguments: {
          workspace: "project",
          command: process.execPath,
          cwd,
        },
      });
      expect(result.isError).toBe(true);
      expect(errorCode(result)).toBe(expectedCode);
    }

    const outside = await mkdtemp(join(tmpdir(), "doctmcp-shell-outside-"));
    roots.push(outside);
    try {
      await symlink(outside, join(root, "escape"), "junction");
    } catch {
      return;
    }
    const escaped = await harness.client.callTool({
      name: "shell.exec",
      arguments: {
        workspace: "project",
        command: process.execPath,
        cwd: "escape",
      },
    });
    expect(escaped.isError).toBe(true);
    expect(errorCode(escaped)).toBe("PATH_OUTSIDE_WORKSPACE");
  });

  test("rejects execute-disabled and denied workspace paths", async () => {
    const deniedCapability = await setup({ execute: false });
    const deniedCapabilityResult =
      await deniedCapability.harness.client.callTool({
        name: "shell.exec",
        arguments: { workspace: "project", command: process.execPath },
      });
    expect(deniedCapabilityResult.isError).toBe(true);
    expect(errorCode(deniedCapabilityResult)).toBe("PERMISSION_DENIED");

    const deniedPath = await setup({ execute: true }, {}, ["blocked"]);
    await mkdir(join(deniedPath.root, "blocked"));
    const deniedPathResult = await deniedPath.harness.client.callTool({
      name: "shell.exec",
      arguments: {
        workspace: "project",
        command: process.execPath,
        cwd: "blocked",
      },
    });
    expect(deniedPathResult.isError).toBe(true);
    expect(errorCode(deniedPathResult)).toBe("PERMISSION_DENIED");
  });

  test("blocks denied executable names before spawning", async () => {
    const { root, harness } = await setup(
      { execute: true },
      { deniedCommands: [basename(process.execPath)] },
    );
    const marker = join(root, "spawned.txt");

    const result = await harness.client.callTool({
      name: "shell.exec",
      arguments: {
        workspace: "project",
        command: process.execPath,
        args: ["-e", 'await Bun.write("spawned.txt", "spawned")'],
      },
    });

    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("PERMISSION_DENIED");
    await expect(lstat(marker)).rejects.toThrow();
  });

  test("terminates a process that exceeds timeout", async () => {
    const { harness } = await setup(
      { execute: true },
      { defaultTimeoutMs: 100, maxTimeoutMs: 500 },
    );
    const result = await harness.client.callTool({
      name: "shell.exec",
      arguments: {
        workspace: "project",
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10_000)"],
      },
    });

    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("TIMEOUT");
  });

  test("rejects timeout above local maximum before spawning", async () => {
    const { harness } = await setup(
      { execute: true },
      { defaultTimeoutMs: 100, maxTimeoutMs: 200 },
    );
    const result = await harness.client.callTool({
      name: "shell.exec",
      arguments: {
        workspace: "project",
        command: process.execPath,
        timeoutMs: 201,
      },
    });

    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("INVALID_INPUT");
  });

  test("caps combined output, terminates the process, and marks result truncated", async () => {
    const { harness } = await setup(
      { execute: true },
      { maxOutputBytes: 128, defaultTimeoutMs: 2_000, maxTimeoutMs: 2_000 },
    );
    const result = await harness.client.callTool({
      name: "shell.exec",
      arguments: {
        workspace: "project",
        command: process.execPath,
        args: [
          "-e",
          'process.stdout.write("x".repeat(4096)); setTimeout(() => {}, 10_000)',
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ truncated: true });
    const output = result.structuredContent as {
      stdout: string;
      stderr: string;
    };
    expect(
      Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr),
    ).toBeLessThanOrEqual(128);
  });

  test("passes spaced and quoted args literally without shell reinterpretation", async () => {
    const { harness } = await setup();
    const literal = 'hello world; echo "not-a-second-command" $HOME';
    const result = await harness.client.callTool({
      name: "shell.exec",
      arguments: {
        workspace: "project",
        command: process.execPath,
        args: ["-e", "console.log(process.argv.at(-1))", literal],
      },
    });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { stdout: string }).stdout.trim()).toBe(
      literal,
    );
  });

  test("does not inherit arbitrary environment secrets", async () => {
    const previous = process.env.DOCTMCP_TEST_SECRET;
    process.env.DOCTMCP_TEST_SECRET = "should-not-leak";
    try {
      const { harness } = await setup();
      const result = await harness.client.callTool({
        name: "shell.exec",
        arguments: {
          workspace: "project",
          command: process.execPath,
          args: [
            "-e",
            'console.log(process.env.DOCTMCP_TEST_SECRET ?? "missing")',
          ],
        },
      });

      expect(result.isError).toBeFalsy();
      expect(
        (result.structuredContent as { stdout: string }).stdout.trim(),
      ).toBe("missing");
    } finally {
      if (previous === undefined) {
        delete process.env.DOCTMCP_TEST_SECRET;
      } else {
        process.env.DOCTMCP_TEST_SECRET = previous;
      }
    }
  });
});
