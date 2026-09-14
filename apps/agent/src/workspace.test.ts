import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolDomainError } from "./errors";
import { createMcpTestHarness } from "./test-harness";
import {
  createWorkspaceTool,
  WorkspacePathResolver,
  WorkspaceRegistry,
} from "./workspace";

describe("WorkspaceRegistry", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function createRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "doctmcp-workspace-"));
    roots.push(root);
    return root;
  }

  test("lists and gets configured workspace metadata", async () => {
    const root = await createRoot();
    const registry = await WorkspaceRegistry.create([
      {
        id: "project",
        name: "Project",
        root,
        capabilities: { read: true, write: true, delete: false, execute: true },
      },
    ]);

    expect(registry.list()).toEqual([
      {
        id: "project",
        name: "Project",
        root: await realpath(root),
        capabilities: { read: true, write: true, delete: false, execute: true },
        deny: [],
      },
    ]);
    expect(registry.get("project")?.id).toBe("project");
    expect(registry.get("missing")).toBeUndefined();
  });

  test("rejects duplicate ids and nonexistent roots", async () => {
    const root = await createRoot();
    await expect(
      WorkspaceRegistry.create([
        { id: "same", name: "One", root, capabilities: {} },
        { id: "same", name: "Two", root, capabilities: {} },
      ]),
    ).rejects.toThrow();
    await expect(
      WorkspaceRegistry.create([
        {
          id: "missing",
          name: "Missing",
          root: join(root, "nope"),
          capabilities: {},
        },
      ]),
    ).rejects.toThrow();
  });

  test("exposes workspace list/get through MCP", async () => {
    const root = await createRoot();
    const registry = await WorkspaceRegistry.create([
      { id: "project", name: "Project", root, capabilities: { read: true } },
    ]);
    const harness = await createMcpTestHarness({
      tools: [createWorkspaceTool(registry)],
    });

    try {
      const listed = await harness.client.callTool({
        name: "workspace",
        arguments: { action: "list" },
      });
      expect(listed.isError).toBeFalsy();
      expect(listed.structuredContent).toEqual({ workspaces: registry.list() });

      const fetched = await harness.client.callTool({
        name: "workspace",
        arguments: { action: "get", workspace: "project" },
      });
      expect(fetched.isError).toBeFalsy();
      expect(fetched.structuredContent).toEqual({
        workspace: registry.get("project"),
      });

      const missing = await harness.client.callTool({
        name: "workspace",
        arguments: { action: "get", workspace: "missing" },
      });
      expect(missing.isError).toBe(true);
      const firstContent = missing.content[0];
      expect(firstContent?.type).toBe("text");
      if (firstContent?.type === "text") {
        expect(JSON.parse(firstContent.text).code).toBe("WORKSPACE_NOT_FOUND");
      }
    } finally {
      await harness.close();
    }
  });
});

describe("WorkspacePathResolver and PermissionChecker", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function setup() {
    const root = await mkdtemp(join(tmpdir(), "doctmcp-resolver-"));
    roots.push(root);
    await mkdir(join(root, "denied"));
    await writeFile(join(root, "readme.txt"), "hello");
    const outside = await mkdtemp(join(tmpdir(), "doctmcp-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    const registry = await WorkspaceRegistry.create([
      {
        id: "project",
        name: "Project",
        root,
        capabilities: {
          read: true,
          write: false,
          delete: false,
          execute: false,
        },
        deny: ["denied"],
      },
    ]);
    return { root, outside, registry };
  }

  test("resolves normal relative paths and rejects unsafe paths", async () => {
    const { root, registry } = await setup();
    const resolver = new WorkspacePathResolver(registry);

    const canonicalRoot = await realpath(root);
    expect((await resolver.resolve("project", "readme.txt")).path).toBe(
      join(canonicalRoot, "readme.txt"),
    );
    expect((await resolver.resolve("project", ".")).path).toBe(canonicalRoot);
    for (const unsafe of [
      "../outside",
      "a/../../outside",
      "/tmp/outside",
      "C:\\outside",
    ]) {
      await expect(resolver.resolve("project", unsafe)).rejects.toMatchObject({
        code: "PATH_OUTSIDE_WORKSPACE",
      });
    }
  });

  test("uses containment instead of a string prefix", async () => {
    const { root, registry } = await setup();
    const sibling = `${root}-sibling`;
    await mkdir(sibling);
    roots.push(sibling);
    await expect(
      new WorkspacePathResolver(registry).resolve(
        "project",
        `../${sibling.split("/").pop()}`,
      ),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  });

  test("rejects symlink escape and deny subtree before capability", async () => {
    const { root, outside, registry } = await setup();
    try {
      await symlink(outside, join(root, "link-out"));
    } catch {
      return;
    }
    const resolver = new WorkspacePathResolver(registry);
    await expect(
      resolver.resolve("project", "link-out/secret.txt"),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
    await expect(
      resolver.resolve("project", "denied/secret.txt"),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  test("denies capabilities that are not configured", async () => {
    const { registry } = await setup();
    const resolver = new WorkspacePathResolver(registry);
    await expect(
      resolver.resolve("project", "readme.txt", "write"),
    ).rejects.toBeInstanceOf(ToolDomainError);
    await expect(
      resolver.resolve("project", "readme.txt", "delete"),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      resolver.resolve("project", "readme.txt", "execute"),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});
