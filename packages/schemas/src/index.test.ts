import { describe, expect, test } from "bun:test";
import * as schemas from "./index";

// Negative type tests: typecheck fails if any tool-execution schemas are reintroduced
// @ts-expect-error commandRequestSchema must not be exported
type _AssertNoCommandRequestSchema = import("./index").commandRequestSchema;

describe("schemas", () => {
  test("starts clean without parallel RPC schemas or unused placeholders", () => {
    expect(Object.keys(schemas)).toEqual([]);
  });
});
