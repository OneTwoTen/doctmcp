import { describe, expect, test } from "bun:test";
import * as protocol from "./index";

// Negative type tests: typecheck fails if any tool-execution RPC type is reintroduced
// @ts-expect-error CommandRequest must not be exported by protocol
type _AssertNoCommandRequest = import("./index").CommandRequest;
// @ts-expect-error CommandResult must not be exported by protocol
type _AssertNoCommandResult = import("./index").CommandResult;
// @ts-expect-error CommandError must not be exported by protocol
type _AssertNoCommandError = import("./index").CommandError;

describe("protocol", () => {
  test("starts clean without parallel RPC tool execution contracts or unused placeholders", () => {
    expect(Object.keys(protocol)).toEqual([]);
  });
});
