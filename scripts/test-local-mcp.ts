import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMcpTestHarness,
  createWorkspaceTool,
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

    harness = await createMcpTestHarness({
      tools: [createWorkspaceTool(registry)],
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
    assert(tools.tools.length === 1, "tools/list không trả đúng số tool");
    assert(
      tools.tools[0]?.name === "workspace",
      "workspace tool chưa được đăng ký",
    );
    console.log("✅ tools/list phát hiện workspace");

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
