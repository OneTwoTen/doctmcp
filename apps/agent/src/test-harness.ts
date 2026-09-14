import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  type CreateLocalMcpServerOptions,
  createLocalMcpServer,
  type LocalMcpServerInstance,
} from "./server";

export interface McpTestHarnessOptions extends CreateLocalMcpServerOptions {
  clientInfo?: {
    name: string;
    version: string;
  };
  /**
   * Cho phép acceptance test kết nối vào runtime instance được assembly bằng
   * production factory thay vì tạo một server/catalog song song chỉ dành cho test.
   */
  serverInstance?: LocalMcpServerInstance;
}

export interface McpTestHarness {
  client: Client;
  serverInstance: LocalMcpServerInstance;
  close: () => Promise<void>;
}

export async function createMcpTestHarness(
  options: McpTestHarnessOptions = {},
): Promise<McpTestHarness> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const serverInstance =
    options.serverInstance ??
    createLocalMcpServer({
      tools: options.tools,
      registry: options.registry,
      serverInfo: options.serverInfo,
    });

  const client = new Client(
    options.clientInfo ?? { name: "test-mcp-client", version: "0.1.0" },
    { capabilities: {} },
  );

  await serverInstance.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    serverInstance,
    close: async () => {
      const results = await Promise.allSettled([
        client.close(),
        serverInstance.close(),
      ]);
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((failure) => failure.reason),
          "Failed to close MCP test harness",
        );
      }
    },
  };
}
