import process from "node:process";
import {
  createMcpTestHarness,
  ToolDomainError,
  ToolRegistry,
  z,
} from "../apps/agent/src/index";

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
      "text" in first &&
      typeof first.text === "string"
    ) {
      return first.text;
    }
  }
  return "";
}

async function main() {
  console.log("==================================================");
  console.log("🚀 KHỞI ĐỘNG LOCAL MCP TEST HARNESS");
  console.log("==================================================\n");

  // 1. Tạo ToolRegistry và đăng ký các tool trước khi khởi tạo kết nối
  console.log("⏳ [1/5] Đang khởi tạo ToolRegistry và đăng ký các tool mẫu...");
  const registry = new ToolRegistry();

  // Tool 1: system.info
  registry.register({
    name: "system.info",
    description: "Lấy thông tin hệ điều hành và runtime môi trường",
    inputSchema: z.object({}),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
    },
    handler: async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              platform: process.platform,
              arch: process.arch,
              bunVersion: process.versions.bun ?? "unknown",
              nodeVersion: process.version,
              timestamp: new Date().toISOString(),
            },
            null,
            2,
          ),
        },
      ],
    }),
  });

  // Tool 2: smoke.calculate
  const calculateInput = z.object({
    a: z.number().describe("Số thứ nhất"),
    b: z.number().describe("Số thứ hai"),
    operation: z
      .enum(["add", "multiply"])
      .describe("Phép toán: add hoặc multiply"),
  });
  const calculateOutput = z.object({
    result: z.number().describe("Kết quả tính toán"),
  });

  registry.register({
    name: "smoke.calculate",
    description: "Thực hiện phép tính cơ bản giữa 2 số",
    inputSchema: calculateInput,
    outputSchema: calculateOutput,
    handler: async ({ a, b, operation }) => {
      const result = operation === "add" ? a + b : a * b;
      return {
        content: [
          {
            type: "text",
            text: `Kết quả ${operation}(${a}, ${b}) = ${result}`,
          },
        ],
        structuredContent: { result },
      };
    },
  });

  // Tool 3: demo.error (minh họa xử lý lỗi có cấu trúc)
  const errorInput = z.object({
    filepath: z.string().describe("Đường dẫn tệp giả định"),
  });

  registry.register({
    name: "demo.error",
    description: "Minh họa trả về ToolDomainError chuẩn MCP",
    inputSchema: errorInput,
    handler: async ({ filepath }) => {
      throw new ToolDomainError(
        "PATH_NOT_FOUND",
        `Không tìm thấy đường dẫn '${filepath}'`,
        { filepath, hint: "Vui lòng kiểm tra lại workspace" },
      );
    },
  });

  console.log(
    "✅ Đã đăng ký 3 tool: [system.info, smoke.calculate, demo.error]\n",
  );

  // 2. Khởi tạo MCP Server & MCP Client in-memory
  console.log(
    "⏳ [2/5] Đang khởi tạo MCP Server và Client qua InMemoryTransport...",
  );
  const harness = await createMcpTestHarness({ registry });

  const serverInfo = harness.client.getServerVersion();
  console.log(
    `✅ Đã kết nối tới Server: '${serverInfo?.name}' (v${serverInfo?.version})\n`,
  );

  // 3. Client khám phá danh sách tools (tools/list)
  console.log("⏳ [3/5] Client gọi 'tools/list'...");
  const listResult = await harness.client.listTools();
  console.log(`✅ Tìm thấy ${listResult.tools.length} tool(s):`);
  for (const tool of listResult.tools) {
    const ro = tool.annotations?.readOnlyHint ? "[read-only]" : "";
    console.log(`   - ${tool.name} ${ro}: ${tool.description}`);
  }
  console.log("");

  // 4. Client gọi tools/call thành công (hỗ trợ outputSchema & structuredContent)
  console.log("⏳ [4/5] Client gọi 'tools/call' cho 'smoke.calculate'...");
  const calcCall = await harness.client.callTool({
    name: "smoke.calculate",
    arguments: { a: 15, b: 27, operation: "add" },
  });

  console.log(`✅ Kết quả Text: "${getText(calcCall)}"`);
  console.log(
    `✅ StructuredContent: ${JSON.stringify(calcCall.structuredContent)}\n`,
  );

  // 5. Client gọi tool ném lỗi domain (demo.error)
  console.log(
    "⏳ [5/5] Client gọi 'tools/call' cho 'demo.error' để kiểm tra format lỗi...",
  );
  const errorCall = await harness.client.callTool({
    name: "demo.error",
    arguments: { filepath: "/tmp/missing-file.txt" },
  });

  console.log(`   isError: ${errorCall.isError}`);
  const errorPayload = JSON.parse(getText(errorCall) || "{}");
  console.log("   Structured Error Payload:");
  console.log(JSON.stringify(errorPayload, null, 2));

  // 6. Dọn dẹp kết nối
  await harness.close();
  console.log("\n==================================================");
  console.log("🎉 TOÀN BỘ TEST LOCAL MCP HOÀN TẤT THÀNH CÔNG!");
  console.log("==================================================");
}

main().catch((err) => {
  console.error("❌ Lỗi khi chạy smoke test:", err);
  process.exit(1);
});
