import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolDomainError } from "./errors";
import {
  createFilesystemWriteTool,
  filesystemWriteInputSchema,
} from "./filesystem-write";
import { createMcpTestHarness } from "./test-harness";
import { WorkspacePathResolver, WorkspaceRegistry } from "./workspace";

describe("filesystem.write", () => {
  const roots: string[] = [];
  let harness: Awaited<ReturnType<typeof createMcpTestHarness>> | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function fixture(readOnly = false) {
    const root = await mkdtemp(join(tmpdir(), "doctmcp-fs-write-"));
    roots.push(root);
    await mkdir(join(root, "existing"));
    await Bun.write(join(root, "file.txt"), "before\nbefore\n");
    const registry = await WorkspaceRegistry.create([
      {
        id: "project",
        name: "Project",
        root,
        capabilities: {
          read: true,
          write: !readOnly,
          delete: false,
          execute: false,
        },
      },
    ]);
    return {
      root,
      registry,
      tool: createFilesystemWriteTool(new WorkspacePathResolver(registry)),
    };
  }

  test("validates discriminated action schemas and defaults", () => {
    const parsed = filesystemWriteInputSchema.parse({
      action: "write",
      workspace: "project",
      path: "new.txt",
      content: "hello",
    });
    expect(parsed.action).toBe("write");
    if (parsed.action !== "write") throw new Error("Expected write input");
    expect(parsed.overwrite).toBeUndefined();
    expect(parsed.createParents).toBeUndefined();
    expect(
      filesystemWriteInputSchema.safeParse({
        action: "move",
        workspace: "project",
        from: "a",
      }).success,
    ).toBe(false);
  });

  test("writes new files and does not implicitly create parents", async () => {
    const { root, tool } = await fixture();
    const created = await tool.handler(
      {
        action: "write",
        workspace: "project",
        path: "new.txt",
        content: "hello",
      },
      { signal: new AbortController().signal },
    );
    expect(created.structuredContent).toMatchObject({
      action: "write",
      path: "new.txt",
      bytes: 5,
      created: true,
    });
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("hello");
    await expect(
      tool.handler(
        {
          action: "write",
          workspace: "project",
          path: "nested/new.txt",
          content: "no parent",
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: "PATH_NOT_FOUND" });
  });

  test("guards existing files, supports atomic overwrite and enforces input limit", async () => {
    const { root, tool } = await fixture();
    const context = { signal: new AbortController().signal };
    await expect(
      tool.handler(
        {
          action: "write",
          workspace: "project",
          path: "file.txt",
          content: "changed",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    await tool.handler(
      {
        action: "write",
        workspace: "project",
        path: "file.txt",
        content: "changed",
        overwrite: true,
      },
      context,
    );
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("changed");
    const limited = createFilesystemWriteTool(
      new WorkspacePathResolver((await fixture()).registry),
      3,
    );
    await expect(
      limited.handler(
        {
          action: "write",
          workspace: "project",
          path: "too-large.txt",
          content: "1234",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "OUTPUT_LIMIT_EXCEEDED" });
    expect(
      await lstat(join(root, "too-large.txt")).catch(() => undefined),
    ).toBeUndefined();
  });

  test("patches exact occurrences and leaves file unchanged on mismatch", async () => {
    const { root, tool } = await fixture();
    const context = { signal: new AbortController().signal };
    await expect(
      tool.handler(
        {
          action: "patch",
          workspace: "project",
          path: "file.txt",
          oldText: "before",
          newText: "after",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe(
      "before\nbefore\n",
    );
    const patched = await tool.handler(
      {
        action: "patch",
        workspace: "project",
        path: "file.txt",
        oldText: "before",
        newText: "after",
        expectedOccurrences: 2,
      },
      context,
    );
    expect(patched.structuredContent).toMatchObject({
      action: "patch",
      occurrences: 2,
    });
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe(
      "after\nafter\n",
    );
  });

  test("creates directories with stable existing semantics and moves files", async () => {
    const { root, tool } = await fixture();
    const context = { signal: new AbortController().signal };
    expect(
      (
        await tool.handler(
          {
            action: "mkdir",
            workspace: "project",
            path: "a/b",
            recursive: true,
          },
          context,
        )
      ).structuredContent,
    ).toMatchObject({ created: true });
    expect(
      (
        await tool.handler(
          { action: "mkdir", workspace: "project", path: "a/b" },
          context,
        )
      ).structuredContent,
    ).toMatchObject({ created: false });
    await tool.handler(
      {
        action: "move",
        workspace: "project",
        from: "file.txt",
        to: "a/moved.txt",
      },
      context,
    );
    expect(await readFile(join(root, "a/moved.txt"), "utf8")).toBe(
      "before\nbefore\n",
    );
    await expect(
      tool.handler(
        {
          action: "move",
          workspace: "project",
          from: "a/moved.txt",
          to: "existing",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
  });

  test("enforces capability and path/symlink boundaries", async () => {
    const { root, tool } = await fixture(true);
    const context = { signal: new AbortController().signal };
    await expect(
      tool.handler(
        { action: "write", workspace: "project", path: "x.txt", content: "x" },
        context,
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      tool.handler(
        {
          action: "write",
          workspace: "project",
          path: "../x.txt",
          content: "x",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
    const outside = await mkdtemp(join(tmpdir(), "doctmcp-fs-write-outside-"));
    roots.push(outside);
    await symlink(outside, join(root, "escape"));
    await expect(
      tool.handler(
        {
          action: "write",
          workspace: "project",
          path: "escape/file.txt",
          content: "x",
        },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolDomainError);
  });

  test("calls all actions through MCP and exposes write annotations", async () => {
    const { registry } = await fixture();
    harness = await createMcpTestHarness({
      tools: [createFilesystemWriteTool(new WorkspacePathResolver(registry))],
    });
    const listed = await harness.client.listTools();
    const definition = listed.tools.find(
      (item) => item.name === "filesystem.write",
    );
    expect(definition?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    const called = await harness.client.callTool({
      name: "filesystem.write",
      arguments: { action: "mkdir", workspace: "project", path: "mcp-dir" },
    });
    expect(called.isError).toBeFalsy();
    expect(called.structuredContent).toMatchObject({
      action: "mkdir",
      created: true,
    });
  });
});
