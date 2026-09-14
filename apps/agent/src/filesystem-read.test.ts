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
import {
  createFilesystemReadTool,
  type FilesystemReadOutput,
  filesystemReadInputSchema,
} from "./filesystem-read";
import { ToolRegistry } from "./registry";
import { createMcpTestHarness } from "./test-harness";
import { WorkspacePathResolver, WorkspaceRegistry } from "./workspace";

describe("filesystem.read", () => {
  const roots: string[] = [];
  let harness: Awaited<ReturnType<typeof createMcpTestHarness>> | undefined;

  afterEach(async () => {
    if (harness) {
      await harness.close();
      harness = undefined;
    }
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function createFixtureWorkspace(
    options: { readCapability?: boolean; deny?: string[] } = {},
  ): Promise<{ root: string; registry: WorkspaceRegistry }> {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "doctmcp-fs-read-")),
    );
    roots.push(root);

    // Dựng cây thư mục mẫu
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await mkdir(join(root, "src", "private"), { recursive: true });
    await mkdir(join(root, "empty"), { recursive: true });
    await mkdir(join(root, "denied"), { recursive: true });

    await writeFile(
      join(root, "readme.txt"),
      "Hello DoctMCP!\nWelcome to M1.\n",
    );
    await writeFile(
      join(root, "src", "a.ts"),
      "export const a = 1;\n// findme keyword\n",
    );
    await writeFile(
      join(root, "src", "b.ts"),
      "export const b = 2;\n// another findme keyword\n",
    );
    await writeFile(
      join(root, "src", "public.ts"),
      "export const pub = true;\n// public keyword\n",
    );
    await writeFile(
      join(root, "src", "private", "secret.ts"),
      "export const secret = true;\n// secret keyword\n",
    );
    await writeFile(
      join(root, "src", "nested", "deep.ts"),
      "export const deep = true;\n",
    );
    await writeFile(join(root, "denied", "secret.txt"), "shhh-secret-content");

    // File tiếng Việt chứa ký tự multi-byte UTF-8
    // "Tiếng Việt": 'T' (1b), 'i' (1b), 'ế' (3b: 0xEA, 0xBF, 0xBF), 'n' (1b), 'g' (1b)
    await writeFile(join(root, "vietnamese.txt"), "Tiếng Việt tuyệt vời!\n");

    // File chứa byte UTF-8 invalid (không có byte 0x00)
    // 0x80, 0x81, 0x82 là các continuation byte đứng trơ trọi không có leading byte
    await writeFile(
      join(root, "invalid-utf8.txt"),
      Buffer.from([0x80, 0x81, 0x82, 0xff]),
    );

    // Binary file (chứa null byte)
    const binBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00]);
    await writeFile(join(root, "image.png"), binBuffer);

    // Symlink nội bộ hợp lệ
    await symlink(join(root, "readme.txt"), join(root, "readme-link.txt"));
    await symlink(join(root, "src"), join(root, "alias"));

    // Symlink trỏ ra ngoài workspace
    const outsideDir = await realpath(
      await mkdtemp(join(tmpdir(), "doctmcp-outside-")),
    );
    roots.push(outsideDir);
    await writeFile(join(outsideDir, "outside.txt"), "outside content");
    await symlink(
      join(outsideDir, "outside.txt"),
      join(root, "escape-link.txt"),
    );

    const registry = await WorkspaceRegistry.create([
      {
        id: "test-ws",
        name: "Test Workspace",
        root,
        capabilities: {
          read: options.readCapability ?? true,
          write: false,
          delete: false,
          execute: false,
        },
        deny: options.deny ?? ["denied", "src/private"],
      },
    ]);

    return { root, registry };
  }

  describe("Schema & Validation", () => {
    test("validates valid input for each action", () => {
      expect(
        filesystemReadInputSchema.safeParse({
          action: "read",
          workspace: "ws",
          path: "file.txt",
        }).success,
      ).toBe(true);

      expect(
        filesystemReadInputSchema.safeParse({
          action: "list",
          workspace: "ws",
        }).success,
      ).toBe(true);

      expect(
        filesystemReadInputSchema.safeParse({
          action: "stat",
          workspace: "ws",
          path: "file.txt",
        }).success,
      ).toBe(true);

      expect(
        filesystemReadInputSchema.safeParse({
          action: "search",
          workspace: "ws",
          query: "hello",
        }).success,
      ).toBe(true);
    });

    test("rejects invalid action and missing required fields", () => {
      expect(
        filesystemReadInputSchema.safeParse({
          action: "unknown",
          workspace: "ws",
        }).success,
      ).toBe(false);

      expect(
        filesystemReadInputSchema.safeParse({
          action: "read",
          workspace: "ws",
          // missing path
        }).success,
      ).toBe(false);

      expect(
        filesystemReadInputSchema.safeParse({
          action: "search",
          workspace: "ws",
          // missing query
        }).success,
      ).toBe(false);
    });

    test("rejects read limit exceeding maximum allowed size", () => {
      expect(
        filesystemReadInputSchema.safeParse({
          action: "read",
          workspace: "ws",
          path: "file.txt",
          limit: 1048577, // > 1MB
        }).success,
      ).toBe(false);
    });
  });

  describe("action: read", () => {
    test("reads file content successfully with UTF-8", async () => {
      const { registry } = await createFixtureWorkspace();
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      const result = await tool.handler(
        { action: "read", workspace: "test-ws", path: "readme.txt" },
        { signal: new AbortController().signal },
      );

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as FilesystemReadOutput;
      expect(structured.action).toBe("read");
      expect(structured.path).toBe("readme.txt");
      expect(structured.content).toBeDefined();
      expect(structured.content).toBe("Hello DoctMCP!\nWelcome to M1.\n");
      expect(structured.truncated).toBe(false);
      expect(structured.size).toBe(structured.content?.length);
      expect(structured.bytesRead).toBe(structured.size);
      expect(structured.nextOffset).toBe(structured.size);
    });

    test("supports offset and limit with truncation flag", async () => {
      const { registry } = await createFixtureWorkspace();
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      const result = await tool.handler(
        {
          action: "read",
          workspace: "test-ws",
          path: "readme.txt",
          offset: 0,
          limit: 5,
        },
        { signal: new AbortController().signal },
      );

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as FilesystemReadOutput;
      expect(structured.content).toBe("Hello");
      expect(structured.truncated).toBe(true);
      expect(structured.offset).toBe(0);
      expect(structured.limit).toBe(5);
      expect(structured.bytesRead).toBe(5);
      expect(structured.nextOffset).toBe(5);
    });

    test("handles multi-byte UTF-8 split at chunk boundary safely", async () => {
      const { registry } = await createFixtureWorkspace();
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      // "Tiếng Việt tuyệt vời!\n"
      // 'T' (offset 0, 1 byte), 'i' (offset 1, 1 byte), 'ế' (offset 2, 3 bytes: 0xEA, 0xBF, 0xBF)
      // Nếu limit là 3, chunk sẽ gồm: 'T', 'i', và byte đầu tiên của 'ế' (0xEA).
      // Tool phải tự động lùi boundary về 2 byte để decode trọn vẹn "Ti",
      // trả về bytesRead: 2, nextOffset: 2, truncated: true
      const chunk1 = await tool.handler(
        {
          action: "read",
          workspace: "test-ws",
          path: "vietnamese.txt",
          offset: 0,
          limit: 3,
        },
        { signal: new AbortController().signal },
      );

      expect(chunk1.isError).toBeFalsy();
      const s1 = chunk1.structuredContent as FilesystemReadOutput;
      expect(s1.content).toBe("Ti");
      expect(s1.bytesRead).toBe(2);
      expect(s1.nextOffset).toBe(2);
      expect(s1.truncated).toBe(true);

      // Đọc tiếp từ nextOffset=2 với limit=15
      const chunk2 = await tool.handler(
        {
          action: "read",
          workspace: "test-ws",
          path: "vietnamese.txt",
          offset: s1.nextOffset,
          limit: 15,
        },
        { signal: new AbortController().signal },
      );

      expect(chunk2.isError).toBeFalsy();
      const s2 = chunk2.structuredContent as FilesystemReadOutput;
      expect(s2.content?.startsWith("ếng Việt")).toBe(true);
    });

    test("rejects invalid UTF-8 files even without NUL bytes", async () => {
      const { registry } = await createFixtureWorkspace();
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      await expect(
        tool.handler(
          { action: "read", workspace: "test-ws", path: "invalid-utf8.txt" },
          { signal: new AbortController().signal },
        ),
      ).rejects.toThrow(ToolDomainError);
    });

    test("rejects nonexistent file with PATH_NOT_FOUND", async () => {
      const { registry } = await createFixtureWorkspace();
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      await expect(
        tool.handler(
          { action: "read", workspace: "test-ws", path: "nonexistent.txt" },
          { signal: new AbortController().signal },
        ),
      ).rejects.toThrow(ToolDomainError);
    });

    test("rejects directory target with INVALID_INPUT", async () => {
      const { registry } = await createFixtureWorkspace();
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      await expect(
        tool.handler(
          { action: "read", workspace: "test-ws", path: "src" },
          { signal: new AbortController().signal },
        ),
      ).rejects.toThrow(ToolDomainError);
    });

    test("rejects binary files with INVALID_INPUT", async () => {
      const { registry } = await createFixtureWorkspace();
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      await expect(
        tool.handler(
          { action: "read", workspace: "test-ws", path: "image.png" },
          { signal: new AbortController().signal },
        ),
      ).rejects.toThrow(ToolDomainError);
    });

    test("rejects path traversal with PATH_OUTSIDE_WORKSPACE", async () => {
      const { registry } = await createFixtureWorkspace();
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      await expect(
        tool.handler(
          { action: "read", workspace: "test-ws", path: "../outside.txt" },
          { signal: new AbortController().signal },
        ),
      ).rejects.toThrow(ToolDomainError);
    });

    test("rejects absolute path escape with PATH_OUTSIDE_WORKSPACE", async () => {
      const { registry } = await createFixtureWorkspace();
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      await expect(
        tool.handler(
          { action: "read", workspace: "test-ws", path: "/etc/passwd" },
          { signal: new AbortController().signal },
        ),
      ).rejects.toThrow(ToolDomainError);
    });

    test("rejects symlink escaping workspace with PATH_OUTSIDE_WORKSPACE", async () => {
      const { registry } = await createFixtureWorkspace();
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      await expect(
        tool.handler(
          { action: "read", workspace: "test-ws", path: "escape-link.txt" },
          { signal: new AbortController().signal },
        ),
      ).rejects.toThrow(ToolDomainError);
    });

    test("rejects reading from denied subtree with PERMISSION_DENIED", async () => {
      const { registry } = await createFixtureWorkspace();
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      await expect(
        tool.handler(
          {
            action: "read",
            workspace: "test-ws",
            path: "denied/secret.txt",
          },
          { signal: new AbortController().signal },
        ),
      ).rejects.toThrow(ToolDomainError);
    });

    test("rejects reading when workspace read capability is false", async () => {
      const { registry } = await createFixtureWorkspace({
        readCapability: false,
      });
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      await expect(
        tool.handler(
          { action: "read", workspace: "test-ws", path: "readme.txt" },
          { signal: new AbortController().signal },
        ),
      ).rejects.toThrow(ToolDomainError);
    });
  });

  describe("action: list", () => {
    test("lists workspace root entries non-recursively by default", async () => {
      const { registry } = await createFixtureWorkspace();
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      const result = await tool.handler(
        { action: "list", workspace: "test-ws" },
        { signal: new AbortController().signal },
      );

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as FilesystemReadOutput;
      expect(structured.action).toBe("list");
      expect(structured.entries).toBeDefined();
      const entries = structured.entries ?? [];
      expect(entries.length).toBeGreaterThan(0);
      const names = entries.map((e) => e.name);
      expect(names).toContain("readme.txt");
      expect(names).toContain("src");
      expect(names).toContain("empty");
      // Thư mục denied không được đưa vào
      expect(names).not.toContain("denied");
      // Symlink trỏ ra ngoài bị loại bỏ
      expect(names).not.toContain("escape-link.txt");
    });

    test("lists subdirectory entries without hiding allowed siblings of denied nested paths", async () => {
      const { registry } = await createFixtureWorkspace({
        deny: ["src/private"],
      });
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      // Thư mục src chứa public.ts và private/
      // private/ bị deny nhưng src và public.ts KHÔNG được bị ẩn!
      const result = await tool.handler(
        { action: "list", workspace: "test-ws", path: "src" },
        { signal: new AbortController().signal },
      );

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as FilesystemReadOutput;
      expect(structured.entries).toBeDefined();
      const names = (structured.entries ?? []).map((e) => e.name);
      expect(names).toContain("a.ts");
      expect(names).toContain("b.ts");
      expect(names).toContain("public.ts");
      expect(names).not.toContain("private");
    });

    test("supports recursive listing with limit and depth truncation", async () => {
      const { registry } = await createFixtureWorkspace();
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      // Giới hạn limit nhỏ để verify cờ truncated
      const result = await tool.handler(
        {
          action: "list",
          workspace: "test-ws",
          recursive: true,
          limit: 3,
        },
        { signal: new AbortController().signal },
      );

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as FilesystemReadOutput;
      expect(structured.entries).toBeDefined();
      expect((structured.entries ?? []).length).toBe(3);
      expect(structured.truncated).toBe(true);
    });

    test("respects maxDepth in recursive listing", async () => {
      const { registry } = await createFixtureWorkspace();
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      // maxDepth = 1 không đi sâu vào nested/deep.ts
      const result = await tool.handler(
        {
          action: "list",
          workspace: "test-ws",
          path: "src",
          recursive: true,
          maxDepth: 1,
        },
        { signal: new AbortController().signal },
      );

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as FilesystemReadOutput;
      const paths = (structured.entries ?? []).map((e) => e.path);
      expect(paths).toContain("src/nested");
      expect(paths).not.toContain("src/nested/deep.ts");
    });

    test("rejects listing a file with INVALID_INPUT", async () => {
      const { registry } = await createFixtureWorkspace();
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      await expect(
        tool.handler(
          { action: "list", workspace: "test-ws", path: "readme.txt" },
          { signal: new AbortController().signal },
        ),
      ).rejects.toThrow(ToolDomainError);
    });
  });

  describe("action: stat", () => {
    test("returns portable metadata for regular file", async () => {
      const { registry } = await createFixtureWorkspace();
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      const result = await tool.handler(
        { action: "stat", workspace: "test-ws", path: "readme.txt" },
        { signal: new AbortController().signal },
      );

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as FilesystemReadOutput;
      expect(structured.action).toBe("stat");
      expect(structured.type).toBe("file");
      expect(structured.size).toBeGreaterThan(0);
      expect(structured.isSymbolicLink).toBe(false);
      expect(structured.mtimeMs).toBeDefined();
    });

    test("returns portable metadata for directory", async () => {
      const { registry } = await createFixtureWorkspace();
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      const result = await tool.handler(
        { action: "stat", workspace: "test-ws", path: "src" },
        { signal: new AbortController().signal },
      );

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as FilesystemReadOutput;
      expect(structured.type).toBe("directory");
      expect(structured.isSymbolicLink).toBe(false);
    });

    test("returns portable metadata for internal symlink", async () => {
      const { registry } = await createFixtureWorkspace();
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      const result = await tool.handler(
        { action: "stat", workspace: "test-ws", path: "readme-link.txt" },
        { signal: new AbortController().signal },
      );

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as FilesystemReadOutput;
      expect(structured.isSymbolicLink).toBe(true);
      expect(structured.type).toBe("symlink");
    });

    test("rejects nonexistent path with PATH_NOT_FOUND", async () => {
      const { registry } = await createFixtureWorkspace();
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      await expect(
        tool.handler(
          { action: "stat", workspace: "test-ws", path: "missing.txt" },
          { signal: new AbortController().signal },
        ),
      ).rejects.toThrow(ToolDomainError);
    });
  });

  describe("action: search", () => {
    test("finds literal matches with line numbers and preview", async () => {
      const { registry } = await createFixtureWorkspace();
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      const result = await tool.handler(
        {
          action: "search",
          workspace: "test-ws",
          query: "findme keyword",
        },
        { signal: new AbortController().signal },
      );

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as FilesystemReadOutput;
      expect(structured.action).toBe("search");
      expect(structured.query).toBe("findme keyword");
      expect(structured.matches).toBeDefined();
      const matches = structured.matches ?? [];
      expect(matches.length).toBe(2);
      expect(matches[0]?.line).toContain("findme keyword");
      expect(matches[0]?.lineNumber).toBe(2);
    });

    test("searches directly inside an internal symlink file", async () => {
      const { registry } = await createFixtureWorkspace();
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      // readme-link.txt trỏ tới readme.txt (chứa "DoctMCP")
      const result = await tool.handler(
        {
          action: "search",
          workspace: "test-ws",
          path: "readme-link.txt",
          query: "DoctMCP",
        },
        { signal: new AbortController().signal },
      );

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as FilesystemReadOutput;
      expect(structured.matches).toBeDefined();
      expect((structured.matches ?? []).length).toBe(1);
      expect((structured.matches ?? [])[0]?.line).toContain("Hello DoctMCP!");
    });

    test("respects maxResults limit with truncation", async () => {
      const { registry } = await createFixtureWorkspace();
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      const result = await tool.handler(
        {
          action: "search",
          workspace: "test-ws",
          query: "findme keyword",
          maxResults: 1,
        },
        { signal: new AbortController().signal },
      );

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as FilesystemReadOutput;
      expect(structured.matches).toBeDefined();
      expect((structured.matches ?? []).length).toBe(1);
      expect(structured.truncated).toBe(true);
    });

    test("skips binary files and nested denied directories in search", async () => {
      const { registry } = await createFixtureWorkspace({
        deny: ["src/private", "denied"],
      });
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      // 1. Tìm trong src: public.ts phải tìm thấy
      const pubResult = await tool.handler(
        {
          action: "search",
          workspace: "test-ws",
          path: "src",
          query: "public keyword",
        },
        { signal: new AbortController().signal },
      );
      const pubStructured = pubResult.structuredContent as FilesystemReadOutput;
      expect((pubStructured.matches ?? []).length).toBe(1);

      // 2. Tìm trong src: secret keyword trong src/private/secret.ts không được tìm thấy
      const secretResult = await tool.handler(
        {
          action: "search",
          workspace: "test-ws",
          path: "src",
          query: "secret keyword",
        },
        { signal: new AbortController().signal },
      );
      const secStructured =
        secretResult.structuredContent as FilesystemReadOutput;
      expect((secStructured.matches ?? []).length).toBe(0);
    });

    test("terminates search when cancellation signal is triggered", async () => {
      const { registry } = await createFixtureWorkspace();
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      const controller = new AbortController();
      controller.abort();

      await expect(
        tool.handler(
          {
            action: "search",
            workspace: "test-ws",
            query: "findme keyword",
          },
          { signal: controller.signal },
        ),
      ).rejects.toThrow(ToolDomainError);
    });

    test("blocks deny bypass when list/search target is a symlink directory", async () => {
      const { registry } = await createFixtureWorkspace({
        deny: ["src/private"],
      });
      const resolver = new WorkspacePathResolver(registry);
      const tool = createFilesystemReadTool(resolver);

      // 1. search query="secret" trong alias (trỏ tới src) -> không được tìm thấy vì src/private bị deny
      const secResult = await tool.handler(
        {
          action: "search",
          workspace: "test-ws",
          path: "alias",
          query: "secret keyword",
        },
        { signal: new AbortController().signal },
      );
      const secStructured = secResult.structuredContent as FilesystemReadOutput;
      expect((secStructured.matches ?? []).length).toBe(0);

      // 2. search query="public" trong alias -> vẫn tìm thấy public.ts
      const pubResult = await tool.handler(
        {
          action: "search",
          workspace: "test-ws",
          path: "alias",
          query: "public keyword",
        },
        { signal: new AbortController().signal },
      );
      const pubStructured = pubResult.structuredContent as FilesystemReadOutput;
      expect((pubStructured.matches ?? []).length).toBe(1);
      expect((pubStructured.matches ?? [])[0]?.line).toContain(
        "public keyword",
      );

      // 3. list recursive=true trong alias -> không chứa alias/private hay alias/private/secret.ts
      const listResult = await tool.handler(
        {
          action: "list",
          workspace: "test-ws",
          path: "alias",
          recursive: true,
        },
        { signal: new AbortController().signal },
      );
      const listStructured =
        listResult.structuredContent as FilesystemReadOutput;
      const paths = (listStructured.entries ?? []).map((e) => e.path);
      expect(paths.some((p) => p.includes("private"))).toBe(false);
      expect(paths.some((p) => p.includes("public.ts"))).toBe(true);
    });
  });

  describe("MCP Integration Test (All 4 Actions)", () => {
    test("registers filesystem.read and calls all 4 actions through MCP protocol", async () => {
      const { registry } = await createFixtureWorkspace();
      const resolver = new WorkspacePathResolver(registry);
      const fsReadTool = createFilesystemReadTool(resolver);

      const toolRegistry = new ToolRegistry();
      toolRegistry.register(fsReadTool);

      harness = await createMcpTestHarness({ registry: toolRegistry });

      // 1. Kiểm tra tools/list
      const listToolsResponse = await harness.client.listTools();
      const tool = listToolsResponse.tools.find(
        (t) => t.name === "filesystem.read",
      );
      expect(tool).toBeDefined();
      expect(tool?.description).toBeDefined();
      expect(tool?.annotations?.readOnlyHint).toBe(true);
      expect(tool?.annotations?.destructiveHint).toBe(false);

      // 2. Gọi action: read qua MCP protocol
      const readResult = await harness.client.callTool({
        name: "filesystem.read",
        arguments: {
          action: "read",
          workspace: "test-ws",
          path: "readme.txt",
        },
      });
      expect(readResult.isError).toBeFalsy();
      const readContent = readResult.structuredContent as FilesystemReadOutput;
      expect(readContent.action).toBe("read");
      expect(readContent.content).toContain("Hello DoctMCP!");
      expect(readContent.bytesRead).toBeDefined();

      // 3. Gọi action: list qua MCP protocol
      const listResult = await harness.client.callTool({
        name: "filesystem.read",
        arguments: {
          action: "list",
          workspace: "test-ws",
          path: "src",
        },
      });
      expect(listResult.isError).toBeFalsy();
      const listContent = listResult.structuredContent as FilesystemReadOutput;
      expect(listContent.action).toBe("list");
      expect(listContent.entries?.some((e) => e.name === "a.ts")).toBe(true);

      // 4. Gọi action: stat qua MCP protocol
      const statResult = await harness.client.callTool({
        name: "filesystem.read",
        arguments: {
          action: "stat",
          workspace: "test-ws",
          path: "readme.txt",
        },
      });
      expect(statResult.isError).toBeFalsy();
      const statContent = statResult.structuredContent as FilesystemReadOutput;
      expect(statContent.action).toBe("stat");
      expect(statContent.type).toBe("file");
      expect(statContent.size).toBeGreaterThan(0);

      // 5. Gọi action: search qua MCP protocol
      const searchResult = await harness.client.callTool({
        name: "filesystem.read",
        arguments: {
          action: "search",
          workspace: "test-ws",
          query: "findme keyword",
        },
      });
      expect(searchResult.isError).toBeFalsy();
      const searchContent =
        searchResult.structuredContent as FilesystemReadOutput;
      expect(searchContent.action).toBe("search");
      expect(searchContent.matches?.length).toBeGreaterThan(0);
    });
  });
});
