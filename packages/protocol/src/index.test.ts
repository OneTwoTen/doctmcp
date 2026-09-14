import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "./index";

// Negative type tests: typecheck fails if any tool-execution RPC type is reintroduced
// @ts-expect-error CommandRequest must not be exported by protocol
type _AssertNoCommandRequest = import("./index").CommandRequest;
// @ts-expect-error CommandResult must not be exported by protocol
type _AssertNoCommandResult = import("./index").CommandResult;
// @ts-expect-error CommandError must not be exported by protocol
type _AssertNoCommandError = import("./index").CommandError;

describe("protocol", () => {
  test("starts at protocol version 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
