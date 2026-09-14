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
  /** Client override chỉ phục vụ regression test cho lifecycle/bootstrap. */
  client?: Client;
}

export interface McpTestHarness {
  client: Client;
  serverInstance: LocalMcpServerInstance;
  close: () => Promise<void>;
}

async function closeHarnessParts(
  client: Client,
  serverInstance: LocalMcpServerInstance,
): Promise<unknown[]> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => client.close()),
    Promise.resolve().then(() => serverInstance.close()),
  ]);
  return results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
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

  const client =
    options.client ??
    new Client(
      options.clientInfo ?? { name: "test-mcp-client", version: "0.1.0" },
      { capabilities: {} },
    );

  try {
    await serverInstance.connect(serverTransport);
    await client.connect(clientTransport);
  } catch (error) {
    // Bootstrap có thể fail sau khi server đã connect. Rollback cả hai phía
    // ngay tại đây vì caller chưa nhận được harness để tự cleanup.
    const cleanupErrors = await closeHarnessParts(client, serverInstance);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Failed to bootstrap and clean up MCP test harness",
      );
    }
    throw error;
  }

  return {
    client,
    serverInstance,
    close: async () => {
      const failures = await closeHarnessParts(client, serverInstance);
      if (failures.length > 0) {
        throw new AggregateError(failures, "Failed to close MCP test harness");
      }
    },
  };
}
