import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFilesystemReadTool,
  createFilesystemWriteTool,
  createMcpTestHarness,
  createSystemTool,
  createWorkspaceTool,
  WorkspacePathResolver,
  WorkspaceRegistry,
} from "../apps/agent/src/index";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function getText(result: unknown): string {
  if (
    typeof result === "object" &&
    result !== null &&
    "content" in result &&
    Array.isArray(result.content) &&
    result.content.length > 0
  ) {
    const first = result.content[0];
    if (
      typeof first === "object" &&
      first !== null &&
      "type" in first &&
      first.type === "text" &&
      "text" in first &&
      typeof first.text === "string"
    ) {
      return first.text;
    }
  }
  return "";
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), "doctmcp-local-mcp-"));
  let harness: Awaited<ReturnType<typeof createMcpTestHarness>> | undefined;

  try {
    console.log("==================================================");
    console.log("🚀 KIỂM TRA LOCAL MCP");
    console.log("==================================================");

    const registry = await WorkspaceRegistry.create([
      {
        id: "local-test",
        name: "Local test workspace",
        root: tempRoot,
        capabilities: {
          read: true,
          write: true,
          delete: false,
          execute: false,
        },
      },
    ]);

    await writeFile(join(tempRoot, "hello.txt"), "Xin chào DoctMCP!\n");

    const resolver = new WorkspacePathResolver(registry);
    harness = await createMcpTestHarness({
      tools: [
        createWorkspaceTool(registry),
        createSystemTool(),
        createFilesystemReadTool(resolver),
        createFilesystemWriteTool(resolver),
      ],
    });

    const serverVersion = harness.client.getServerVersion();
    assert(
      serverVersion?.name === "doctmcp-agent",
      "MCP server không initialize đúng",
    );
    console.log(
      `✅ Đã initialize MCP server ${serverVersion.name} v${serverVersion.version}`,
    );

    const tools = await harness.client.listTools();
    assert(
      tools.tools.length === 4,
      "tools/list không trả đúng số tool đã triển khai",
    );
    const toolNames = tools.tools.map((tool) => tool.name);
    assert(toolNames.includes("workspace"), "workspace tool chưa được đăng ký");
    assert(toolNames.includes("system"), "system tool chưa được đăng ký");
    assert(
      toolNames.includes("filesystem.read"),
      "filesystem.read tool chưa được đăng ký",
    );
    assert(
      toolNames.includes("filesystem.write"),
      "filesystem.write tool chưa được đăng ký",
    );
    console.log(
      "✅ tools/list phát hiện workspace, system, filesystem.read và filesystem.write",
    );

    const systemInfo = await harness.client.callTool({
      name: "system",
      arguments: { action: "info" },
    });
    assert(!systemInfo.isError, "system/info trả lỗi");
    assert(
      getText(systemInfo).includes('"runtime"'),
      "system/info thiếu runtime metadata",
    );
    console.log("✅ tools/call system/info thành công");

    const listed = await harness.client.callTool({
      name: "workspace",
      arguments: { action: "list" },
    });
    assert(!listed.isError, "workspace/list trả lỗi");
    assert(
      getText(listed).includes("local-test"),
      "workspace/list thiếu workspace test",
    );
    console.log("✅ tools/call workspace/list thành công");

    const fetched = await harness.client.callTool({
      name: "workspace",
      arguments: { action: "get", workspace: "local-test" },
    });
    assert(!fetched.isError, "workspace/get trả lỗi");
    assert(
      getText(fetched).includes("Local test workspace"),
      "workspace/get sai metadata",
    );
    console.log("✅ tools/call workspace/get thành công");

    const missing = await harness.client.callTool({
      name: "workspace",
      arguments: { action: "get", workspace: "missing" },
    });
    assert(missing.isError, "workspace/get unknown id phải trả lỗi");
    assert(
      getText(missing).includes("WORKSPACE_NOT_FOUND"),
      "Mã lỗi unknown workspace không đúng",
    );
    console.log("✅ unknown workspace bị từ chối đúng mã lỗi");

    const writeRes = await harness.client.callTool({
      name: "filesystem.write",
      arguments: {
        action: "write",
        workspace: "local-test",
        path: "generated.txt",
        content: "Nội dung được tạo qua MCP\n",
      },
    });
    assert(!writeRes.isError, "filesystem.write trả lỗi");
    assert(
      getText(writeRes).includes("generated.txt"),
      "filesystem.write trả sai path",
    );
    console.log("✅ tools/call filesystem.write (action: write) thành công");

    const readGeneratedRes = await harness.client.callTool({
      name: "filesystem.read",
      arguments: {
        action: "read",
        workspace: "local-test",
        path: "generated.txt",
      },
    });
    assert(!readGeneratedRes.isError, "filesystem.read generated.txt trả lỗi");
    assert(
      getText(readGeneratedRes).includes("Nội dung được tạo qua MCP"),
      "filesystem.read không đọc được file vừa tạo qua filesystem.write",
    );
    console.log("✅ filesystem.write → filesystem.read round-trip thành công");

    const readRes = await harness.client.callTool({
      name: "filesystem.read",
      arguments: {
        action: "read",
        workspace: "local-test",
        path: "hello.txt",
      },
    });
    assert(!readRes.isError, "filesystem.read trả lỗi");
    assert(
      getText(readRes).includes("Xin chào DoctMCP!"),
      "filesystem.read đọc sai nội dung",
    );
    console.log("✅ tools/call filesystem.read (action: read) thành công");

    const listRes = await harness.client.callTool({
      name: "filesystem.read",
      arguments: {
        action: "list",
        workspace: "local-test",
      },
    });
    assert(!listRes.isError, "filesystem.read list trả lỗi");
    assert(
      getText(listRes).includes("hello.txt") &&
        getText(listRes).includes("generated.txt"),
      "filesystem.read list thiếu file fixture hoặc file vừa tạo",
    );
    console.log("✅ tools/call filesystem.read (action: list) thành công");

    const escapeRes = await harness.client.callTool({
      name: "filesystem.read",
      arguments: {
        action: "read",
        workspace: "local-test",
        path: "../outside.txt",
      },
    });
    assert(escapeRes.isError, "Path traversal phải bị từ chối");
    assert(
      getText(escapeRes).includes("PATH_OUTSIDE_WORKSPACE"),
      "Path traversal trả sai mã lỗi",
    );
    console.log("✅ path traversal bị từ chối đúng mã lỗi");

    console.log("🎉 LOCAL MCP TEST PASS");
  } finally {
    if (harness) {
      await harness.close();
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error("❌ LOCAL MCP TEST FAIL", error);
  process.exitCode = 1;
});
