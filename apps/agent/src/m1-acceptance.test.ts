import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalMcpRuntime } from "./local-mcp-runtime";
import { createMcpTestHarness, type McpTestHarness } from "./test-harness";
import { WorkspaceRegistry } from "./workspace";

const expectedCatalog = {
  workspace: {
    actions: ["get", "list"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  system: {
    actions: ["info", "which"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  "filesystem.read": {
    actions: ["list", "read", "search", "stat"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  "filesystem.write": {
    actions: ["mkdir", "move", "patch", "write"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
  },
  "filesystem.delete": {
    actions: [],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
  },
  "shell.exec": {
    actions: [],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
  },
} as const;

function getText(result: unknown): string {
  if (
    typeof result !== "object" ||
    result === null ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    throw new Error("Expected MCP result content");
  }

  const first = result.content[0];
  if (
    typeof first !== "object" ||
    first === null ||
    !("type" in first) ||
    first.type !== "text" ||
    !("text" in first) ||
    typeof first.text !== "string"
  ) {
    throw new Error("Expected text content in MCP result");
  }

  return first.text;
}

function getErrorCode(result: unknown): string {
  const parsed = JSON.parse(getText(result)) as { code?: unknown };
  if (typeof parsed.code !== "string") {
    throw new Error("Expected structured MCP error code");
  }
  return parsed.code;
}

function schemaHasProperty(schema: unknown, property: string): boolean {
  if (Array.isArray(schema)) {
    return schema.some((entry) => schemaHasProperty(entry, property));
  }
  if (typeof schema !== "object" || schema === null) {
    return false;
  }

  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  if (
    typeof properties === "object" &&
    properties !== null &&
    property in properties
  ) {
    return true;
  }

  return Object.values(record).some((value) =>
    schemaHasProperty(value, property),
  );
}

function collectActionValues(schema: unknown): string[] {
  const actions = new Set<string>();

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (typeof value !== "object" || value === null) {
      return;
    }

    const record = value as Record<string, unknown>;
    const properties = record.properties;
    if (typeof properties === "object" && properties !== null) {
      const action = (properties as Record<string, unknown>).action;
      if (typeof action === "object" && action !== null) {
        const actionRecord = action as Record<string, unknown>;
        if (typeof actionRecord.const === "string") {
          actions.add(actionRecord.const);
        }
        if (Array.isArray(actionRecord.enum)) {
          for (const entry of actionRecord.enum) {
            if (typeof entry === "string") actions.add(entry);
          }
        }
      }
    }

    for (const child of Object.values(record)) visit(child);
  };

  visit(schema);
  return [...actions].sort();
}

async function expectProtocolFailure(call: Promise<unknown>): Promise<void> {
  let failed = false;
  try {
    const result = (await call) as { isError?: boolean };
    failed = result.isError === true;
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
}

describe("M1 local MCP acceptance", () => {
  const roots: string[] = [];
  const harnesses: McpTestHarness[] = [];

  afterEach(async () => {
    const closeResults = await Promise.allSettled(
      harnesses.splice(0).map((harness) => harness.close()),
    );
    const cleanupResults = await Promise.allSettled(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
    const failures = [...closeResults, ...cleanupResults].filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "M1 acceptance cleanup failed",
      );
    }
  });

  async function setup() {
    const root = await mkdtemp(join(tmpdir(), "doctmcp-m1-acceptance-"));
    const restrictedRoot = await mkdtemp(
      join(tmpdir(), "doctmcp-m1-restricted-"),
    );
    roots.push(root, restrictedRoot);

    await mkdir(join(root, "blocked"));
    await writeFile(join(root, "fixture.txt"), "fixture\n");
    await writeFile(join(root, "blocked", "secret.txt"), "secret\n");

    const registry = await WorkspaceRegistry.create([
      {
        id: "project",
        name: "Acceptance project",
        root,
        capabilities: {
          read: true,
          write: true,
          delete: true,
          execute: true,
        },
        deny: ["blocked"],
      },
      {
        id: "read-only",
        name: "Read-only project",
        root: restrictedRoot,
        capabilities: {
          read: true,
          write: false,
          delete: false,
          execute: false,
        },
      },
    ]);

    const harness = await createMcpTestHarness({
      serverInstance: createLocalMcpRuntime(registry, {
        shellExec: {
          defaultTimeoutMs: 100,
          maxTimeoutMs: 500,
          maxOutputBytes: 128,
          killGraceMs: 25,
        },
      }),
    });
    harnesses.push(harness);

    return { root, restrictedRoot, harness };
  }

  test("initialize và tools/list khóa đúng catalog, schema và annotations M1", async () => {
    const { harness } = await setup();

    expect(harness.client.getServerVersion()).toMatchObject({
      name: "doctmcp-agent",
      version: "0.1.0",
    });

    const listed = await harness.client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
      Object.keys(expectedCatalog).sort(),
    );

    for (const tool of listed.tools) {
      const expected =
        expectedCatalog[tool.name as keyof typeof expectedCatalog];
      expect(expected).toBeDefined();
      expect(tool.description?.trim().length ?? 0).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
      expect(tool.annotations).toMatchObject(expected.annotations);
      expect(collectActionValues(tool.inputSchema)).toEqual([
        ...expected.actions,
      ]);

      if (
        tool.name === "workspace" ||
        tool.name.startsWith("filesystem.") ||
        tool.name === "shell.exec"
      ) {
        expect(schemaHasProperty(tool.inputSchema, "workspace")).toBe(true);
      }
    }
  });

  test("vertical flow gọi thành công đủ 6 tool qua MCP protocol thật", async () => {
    const { root, harness } = await setup();

    const workspaces = await harness.client.callTool({
      name: "workspace",
      arguments: { action: "list" },
    });
    expect(workspaces.isError).toBeFalsy();
    expect(getText(workspaces)).toContain("project");

    const write = await harness.client.callTool({
      name: "filesystem.write",
      arguments: {
        action: "write",
        workspace: "project",
        path: "temp.txt",
        content: "m1 acceptance\n",
      },
    });
    expect(write.isError).toBeFalsy();
    expect(await readFile(join(root, "temp.txt"), "utf8")).toBe(
      "m1 acceptance\n",
    );

    const read = await harness.client.callTool({
      name: "filesystem.read",
      arguments: {
        action: "read",
        workspace: "project",
        path: "temp.txt",
      },
    });
    expect(read.isError).toBeFalsy();
    expect(getText(read)).toContain("m1 acceptance");

    const system = await harness.client.callTool({
      name: "system",
      arguments: { action: "info" },
    });
    expect(system.isError).toBeFalsy();
    expect(system.structuredContent).toMatchObject({
      runtime: { name: "bun" },
    });

    const shell = await harness.client.callTool({
      name: "shell.exec",
      arguments: {
        workspace: "project",
        command: process.execPath,
        args: ["-e", 'console.log("m1-shell-ok")'],
      },
    });
    expect(shell.isError).toBeFalsy();
    expect(shell.structuredContent).toMatchObject({
      exitCode: 0,
      stdout: "m1-shell-ok\n",
      truncated: false,
    });

    const deleted = await harness.client.callTool({
      name: "filesystem.delete",
      arguments: {
        workspace: "project",
        path: "temp.txt",
      },
    });
    expect(deleted.isError).toBeFalsy();
    await expect(lstat(join(root, "temp.txt"))).rejects.toThrow();

    const finalList = await harness.client.callTool({
      name: "filesystem.read",
      arguments: {
        action: "list",
        workspace: "project",
      },
    });
    expect(finalList.isError).toBeFalsy();
    expect(getText(finalList)).not.toContain("temp.txt");
  });

  test("unknown tool, invalid schema và domain error không làm server crash", async () => {
    const { harness } = await setup();

    await expectProtocolFailure(
      harness.client.callTool({
        name: "unknown.tool",
        arguments: {},
      }),
    );

    await expectProtocolFailure(
      harness.client.callTool({
        name: "workspace",
        arguments: { action: "get" },
      }),
    );

    const missingWorkspace = await harness.client.callTool({
      name: "workspace",
      arguments: { action: "get", workspace: "missing" },
    });
    expect(missingWorkspace.isError).toBe(true);
    expect(getErrorCode(missingWorkspace)).toBe("WORKSPACE_NOT_FOUND");

    const healthy = await harness.client.callTool({
      name: "system",
      arguments: { action: "info" },
    });
    expect(healthy.isError).toBeFalsy();
  });

  test("security regression chặn traversal, symlink escape, deny và root delete", async () => {
    const { root, harness } = await setup();

    const traversal = await harness.client.callTool({
      name: "filesystem.read",
      arguments: {
        action: "read",
        workspace: "project",
        path: "../outside.txt",
      },
    });
    expect(traversal.isError).toBe(true);
    expect(getErrorCode(traversal)).toBe("PATH_OUTSIDE_WORKSPACE");

    const outsideRoot = await mkdtemp(join(tmpdir(), "doctmcp-m1-outside-"));
    roots.push(outsideRoot);
    await writeFile(join(outsideRoot, "secret.txt"), "outside\n");
    await symlink(
      outsideRoot,
      join(root, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const symlinkEscape = await harness.client.callTool({
      name: "filesystem.read",
      arguments: {
        action: "read",
        workspace: "project",
        path: "escape/secret.txt",
      },
    });
    expect(symlinkEscape.isError).toBe(true);
    expect(getErrorCode(symlinkEscape)).toBe("PATH_OUTSIDE_WORKSPACE");

    const deniedPath = await harness.client.callTool({
      name: "filesystem.read",
      arguments: {
        action: "read",
        workspace: "project",
        path: "blocked/secret.txt",
      },
    });
    expect(deniedPath.isError).toBe(true);
    expect(getErrorCode(deniedPath)).toBe("PERMISSION_DENIED");

    const deniedCapability = await harness.client.callTool({
      name: "filesystem.write",
      arguments: {
        action: "write",
        workspace: "read-only",
        path: "denied.txt",
        content: "must not be written",
      },
    });
    expect(deniedCapability.isError).toBe(true);
    expect(getErrorCode(deniedCapability)).toBe("PERMISSION_DENIED");

    const rootDelete = await harness.client.callTool({
      name: "filesystem.delete",
      arguments: {
        workspace: "project",
        path: ".",
        recursive: true,
      },
    });
    expect(rootDelete.isError).toBe(true);
    expect(getErrorCode(rootDelete)).toBe("PERMISSION_DENIED");
    expect((await lstat(root)).isDirectory()).toBe(true);
  });

  test("shell timeout và output limit giữ server hoạt động sau khi terminate", async () => {
    const { harness } = await setup();

    const timedOut = await harness.client.callTool({
      name: "shell.exec",
      arguments: {
        workspace: "project",
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10_000)"],
      },
    });
    expect(timedOut.isError).toBe(true);
    expect(getErrorCode(timedOut)).toBe("TIMEOUT");

    const limited = await harness.client.callTool({
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
    expect(limited.isError).toBeFalsy();
    expect(limited.structuredContent).toMatchObject({ truncated: true });
    const output = limited.structuredContent as {
      stdout: string;
      stderr: string;
    };
    expect(
      Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr),
    ).toBeLessThanOrEqual(128);

    const healthy = await harness.client.callTool({
      name: "workspace",
      arguments: { action: "list" },
    });
    expect(healthy.isError).toBeFalsy();
  });
});
