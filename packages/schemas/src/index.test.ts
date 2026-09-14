import { describe, expect, test } from "bun:test";
import { deviceIdSchema } from "./index";

describe("deviceIdSchema", () => {
  test("accepts a valid device id", () => {
    const result = deviceIdSchema.safeParse("device-123");
    expect(result.success).toBe(true);
  });

  test("rejects an empty device id", () => {
    const result = deviceIdSchema.safeParse("");
    expect(result.success).toBe(false);
  });

  test("rejects device id exceeding max length", () => {
    const result = deviceIdSchema.safeParse("a".repeat(129));
    expect(result.success).toBe(false);
  });
});
