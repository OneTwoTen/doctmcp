import { describe, expect, test } from "bun:test";
import { BRIDGE_PROTOCOL_VERSION, bridgeMessageSchema } from "./index";

// Negative type tests: contract không được quay lại thành RPC thực thi tool riêng.
// @ts-expect-error CommandRequest must not be exported by protocol
type _AssertNoCommandRequest = import("./index").CommandRequest;
// @ts-expect-error CommandResult must not be exported by protocol
type _AssertNoCommandResult = import("./index").CommandResult;
// @ts-expect-error CommandError must not be exported by protocol
type _AssertNoCommandError = import("./index").CommandError;

describe("protocol", () => {
  test("exports bridge control-plane contract without parallel tool RPC", () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe("1");
    expect(
      bridgeMessageSchema.parse({
        kind: "bridge.error",
        code: "HANDSHAKE_REQUIRED",
        message: "Handshake is required before MCP messages",
      }),
    ).toMatchObject({ kind: "bridge.error", code: "HANDSHAKE_REQUIRED" });
  });
});
