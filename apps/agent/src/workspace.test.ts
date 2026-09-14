import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ToolDomainError } from "./errors";
import { createMcpTestHarness } from "./test-harness";
import {
  createWorkspaceTool,
  isPathInside,
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

  test("freezes nested policy metadata after create", async () => {
    const root = await createRoot();
    const registry = await WorkspaceRegistry.create([
      {
        id: "project",
        name: "Project",
        root,
        capabilities: { read: true, write: false },
        deny: ["private"],
      },
    ]);
    const workspace = registry.get("project");
    expect(workspace).toBeDefined();
    expect(Object.isFrozen(workspace)).toBe(true);
    expect(Object.isFrozen(workspace?.capabilities)).toBe(true);
    expect(Object.isFrozen(workspace?.deny)).toBe(true);

    expect(() => {
      if (!workspace) throw new Error("Expected workspace");
      (workspace.capabilities as { write: boolean }).write = true;
    }).toThrow(TypeError);
    expect(() => {
      if (!workspace) throw new Error("Expected workspace");
      (workspace.deny as string[]).push("public");
    }).toThrow(TypeError);

    expect(registry.get("project")?.capabilities.write).toBe(false);
    expect(registry.get("project")?.deny).toEqual(["private"]);
  });

  test("rejects identical and parent/child workspace roots", async () => {
    const parent = await createRoot();
    const child = join(parent, "child");
    await mkdir(child);
    const config = (id: string, root: string) => ({
      id,
      name: id,
      root,
      capabilities: { read: true },
    });

    await expect(
      WorkspaceRegistry.create([
        config("parent", parent),
        config("child", child),
      ]),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      WorkspaceRegistry.create([config("one", parent), config("two", parent)]),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
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
    const resolvedFile = await resolver.resolve("project", "readme.txt");
    expect(resolvedFile.operationPath).toBe(join(canonicalRoot, "readme.txt"));
    expect(resolvedFile.canonicalPath).toBe(resolvedFile.operationPath);
    expect((await resolver.resolve("project", ".")).operationPath).toBe(
      canonicalRoot,
    );
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
    const canonicalRoot = await realpath(root);
    const sibling = `${canonicalRoot}-sibling`;
    expect(isPathInside(canonicalRoot, sibling)).toBe(false);
    expect(isPathInside(canonicalRoot, join(canonicalRoot, "child"))).toBe(
      true,
    );
    expect(basename(sibling)).toBeDefined();
    const resolver = new WorkspacePathResolver(registry);
    await expect(
      resolver.resolve("project", `../${basename(sibling)}`),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  });

  test("rejects symlink escape", async () => {
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
  });

  test("does not bypass deny subtree through a symlink", async () => {
    const { root, registry } = await setup();
    const publicRoot = join(root, "public");
    await mkdir(publicRoot);
    await writeFile(join(publicRoot, "file.txt"), "public");
    try {
      await symlink(publicRoot, join(root, "denied", "link"));
    } catch {
      return;
    }
    const resolver = new WorkspacePathResolver(registry);
    await expect(
      resolver.resolve("project", "denied/link/file.txt", "read"),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  test("denies allowed path symlinked into a deny subtree", async () => {
    const { root, registry } = await setup();
    const deniedFile = join(root, "denied", "file.txt");
    await writeFile(deniedFile, "denied");
    try {
      await symlink(deniedFile, join(root, "allowed-link.txt"));
    } catch {
      return;
    }
    const resolver = new WorkspacePathResolver(registry);
    await expect(
      resolver.resolve("project", "allowed-link.txt", "read"),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  test("keeps delete operation on the symlink instead of its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "doctmcp-symlink-delete-"));
    roots.push(root);
    const target = join(root, "actual.txt");
    const link = join(root, "link.txt");
    await writeFile(target, "target");
    try {
      await symlink(target, link);
    } catch {
      return;
    }
    const registry = await WorkspaceRegistry.create([
      {
        id: "project",
        name: "Project",
        root,
        capabilities: { read: true, delete: true },
      },
    ]);
    const resolved = await new WorkspacePathResolver(registry).resolve(
      "project",
      "link.txt",
      "delete",
    );
    expect(resolved.operationPath).toBe(join(await realpath(root), "link.txt"));
    expect(resolved.canonicalPath).toBe(await realpath(target));
    expect((await lstat(resolved.operationPath)).isSymbolicLink()).toBe(true);
  });

  test("allows deleting an in-workspace symlink to an outside target", async () => {
    const root = await mkdtemp(join(tmpdir(), "doctmcp-symlink-outside-"));
    const outside = await mkdtemp(join(tmpdir(), "doctmcp-symlink-target-"));
    roots.push(root, outside);
    const target = join(outside, "outside.txt");
    const link = join(root, "link-out.txt");
    await writeFile(target, "outside");
    try {
      await symlink(target, link);
    } catch {
      return;
    }
    const registry = await WorkspaceRegistry.create([
      {
        id: "project",
        name: "Project",
        root,
        capabilities: { read: true, delete: true },
      },
    ]);
    const resolved = await new WorkspacePathResolver(registry).resolve(
      "project",
      "link-out.txt",
      "delete",
    );
    expect(resolved.operationPath).toBe(
      join(await realpath(root), "link-out.txt"),
    );
    expect(resolved.canonicalPath).toBe(await realpath(target));
    expect((await lstat(resolved.operationPath)).isSymbolicLink()).toBe(true);
  });

  test("rejects deleting a symlink whose parent escapes through an ancestor symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "doctmcp-intermediate-link-"));
    const outside = await mkdtemp(
      join(tmpdir(), "doctmcp-intermediate-target-"),
    );
    roots.push(root, outside);
    const target = join(outside, "target.txt");
    const victimLink = join(outside, "victim-link.txt");
    await writeFile(target, "target");
    try {
      await symlink(target, victimLink);
      await symlink(outside, join(root, "out"));
    } catch {
      return;
    }
    const registry = await WorkspaceRegistry.create([
      {
        id: "project",
        name: "Project",
        root,
        capabilities: { read: true, delete: true },
      },
    ]);

    await expect(
      new WorkspacePathResolver(registry).resolve(
        "project",
        "out/victim-link.txt",
        "delete",
      ),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  });

  test("denies configured subtree before capability", async () => {
    const { registry } = await setup();
    const resolver = new WorkspacePathResolver(registry);
    await expect(
      resolver.resolve("project", "denied/secret.txt"),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  test("always denies deleting the workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "doctmcp-delete-root-"));
    roots.push(root);
    const registry = await WorkspaceRegistry.create([
      {
        id: "deletable",
        name: "Deletable",
        root,
        capabilities: { read: true, delete: true },
      },
    ]);

    await expect(
      new WorkspacePathResolver(registry).resolve("deletable", ".", "delete"),
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
