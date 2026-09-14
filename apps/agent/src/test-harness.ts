import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { ToolRegistry } from "./registry";
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
}

export interface McpTestHarness {
  client: Client;
  server: LocalMcpServerInstance["server"];
  serverInstance: LocalMcpServerInstance;
  registry: ToolRegistry;
  close: () => Promise<void>;
}

export async function createMcpTestHarness(
  options: McpTestHarnessOptions = {},
): Promise<McpTestHarness> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const serverInstance = createLocalMcpServer({
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
    server: serverInstance.server,
    serverInstance,
    registry: serverInstance.registry,
    close: async () => {
      await client.close();
      await serverInstance.close();
    },
  };
}
