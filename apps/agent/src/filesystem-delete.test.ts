import { afterEach, describe, expect, test } from "bun:test";
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
import { createFilesystemDeleteTool } from "./filesystem-delete";
import { createMcpTestHarness } from "./test-harness";
import { WorkspaceRegistry } from "./workspace";

describe("filesystem.delete", () => {
  const roots: string[] = [];
  const harnesses: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function setup(capabilities = { delete: true }, deny?: string[]) {
    const root = await mkdtemp(join(tmpdir(), "doctmcp-delete-tool-"));
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
      tools: [createFilesystemDeleteTool(registry)],
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

  test("deletes a file through MCP and returns structured result", async () => {
    const { root, harness } = await setup();
    await writeFile(join(root, "example.txt"), "content");

    const result = await harness.client.callTool({
      name: "filesystem.delete",
      arguments: { workspace: "project", path: "example.txt" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      deleted: true,
      path: "example.txt",
      type: "file",
    });
    await expect(lstat(join(root, "example.txt"))).rejects.toThrow();
  });

  test("deletes an empty directory and supports recursive delete explicitly", async () => {
    const { root, harness } = await setup();
    await mkdir(join(root, "empty"));
    const emptyResult = await harness.client.callTool({
      name: "filesystem.delete",
      arguments: { workspace: "project", path: "empty" },
    });
    expect(emptyResult.isError).toBeFalsy();
    expect(emptyResult.structuredContent).toEqual({
      deleted: true,
      path: "empty",
      type: "directory",
    });

    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "file.txt"), "content");
    const recursiveResult = await harness.client.callTool({
      name: "filesystem.delete",
      arguments: { workspace: "project", path: "nested", recursive: true },
    });
    expect(recursiveResult.isError).toBeFalsy();
    await expect(lstat(join(root, "nested"))).rejects.toThrow();
  });

  test("rejects a non-empty directory when recursive is omitted or false", async () => {
    const { root, harness } = await setup();
    await mkdir(join(root, "non-empty"));
    await writeFile(join(root, "non-empty", "file.txt"), "content");

    for (const recursive of [undefined, false]) {
      const result = await harness.client.callTool({
        name: "filesystem.delete",
        arguments: {
          workspace: "project",
          path: "non-empty",
          ...(recursive === undefined ? {} : { recursive }),
        },
      });
      expect(result.isError).toBe(true);
      expect(errorCode(result)).toBe("PERMISSION_DENIED");
      expect(await readFile(join(root, "non-empty", "file.txt"), "utf8")).toBe(
        "content",
      );
    }
  });

  test("rejects workspace root, traversal, denied paths, and missing targets", async () => {
    const { root, harness } = await setup({ delete: true }, ["denied"]);
    await mkdir(join(root, "denied"));
    await writeFile(join(root, "denied", "secret.txt"), "secret");

    for (const [path, expectedCode] of [
      [".", "PERMISSION_DENIED"],
      ["", "PATH_OUTSIDE_WORKSPACE"],
      ["../outside", "PATH_OUTSIDE_WORKSPACE"],
      ["denied/secret.txt", "PERMISSION_DENIED"],
    ]) {
      const result = await harness.client.callTool({
        name: "filesystem.delete",
        arguments: { workspace: "project", path },
      });
      expect(result.isError).toBe(true);
      expect(errorCode(result)).toBe(expectedCode);
    }

    const missing = await harness.client.callTool({
      name: "filesystem.delete",
      arguments: { workspace: "project", path: "missing.txt" },
    });
    expect(missing.isError).toBe(true);
    expect(errorCode(missing)).toBe("PATH_NOT_FOUND");
  });

  test("deletes a symlink itself without touching its target", async () => {
    const { root, harness } = await setup();
    const target = join(root, "target.txt");
    const link = join(root, "link.txt");
    await writeFile(target, "keep");
    try {
      await symlink(target, link);
    } catch {
      return;
    }

    const result = await harness.client.callTool({
      name: "filesystem.delete",
      arguments: { workspace: "project", path: "link.txt" },
    });
    expect(result.isError).toBeFalsy();
    await expect(readFile(target, "utf8")).resolves.toBe("keep");
    await expect(lstat(link)).rejects.toThrow();
  });

  test("enforces the separate delete capability without changing the filesystem", async () => {
    const { root, harness } = await setup({ delete: false });
    await writeFile(join(root, "protected.txt"), "keep");
    const result = await harness.client.callTool({
      name: "filesystem.delete",
      arguments: { workspace: "project", path: "protected.txt" },
    });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("PERMISSION_DENIED");
    await expect(readFile(join(root, "protected.txt"), "utf8")).resolves.toBe(
      "keep",
    );
  });
});
