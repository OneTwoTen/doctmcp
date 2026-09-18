import { describe, expect, test } from "bun:test";
import { stopDoctmcpServer } from "./index";

describe("server shutdown", () => {
  test("stops the runtime before surfacing a public MCP close failure", async () => {
    const closeFailure = new Error("public MCP close failed");
    let runtimeStopped = false;

    await expect(
      stopDoctmcpServer(
        {
          close: async () => {
            throw closeFailure;
          },
        },
        {
          stop: async () => {
            runtimeStopped = true;
          },
        },
      ),
    ).rejects.toBe(closeFailure);

    expect(runtimeStopped).toBeTrue();
  });
});
