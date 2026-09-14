import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { createLocalMcpServer } from "./server";
import { createMcpTestHarness } from "./test-harness";

class FailingConnectClient extends Client {
  closeCalls = 0;

  constructor() {
    super(
      { name: "failing-test-client", version: "0.1.0" },
      { capabilities: {} },
    );
  }

  override async connect(
    _transport: Parameters<Client["connect"]>[0],
  ): Promise<void> {
    throw new Error("intentional client connect failure");
  }

  override async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

describe("MCP test harness lifecycle", () => {
  test("rollback client và server khi client.connect fail sau server.connect", async () => {
    const serverInstance = createLocalMcpServer();
    const client = new FailingConnectClient();

    await expect(
      createMcpTestHarness({ serverInstance, client }),
    ).rejects.toThrow("intentional client connect failure");

    expect(client.closeCalls).toBe(1);
    expect(serverInstance.isConnected).toBe(false);
  });
});
