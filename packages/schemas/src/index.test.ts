import { describe, expect, test } from "bun:test";
import { commandRequestSchema } from "./index";

describe("commandRequestSchema", () => {
  test("accepts a valid command request", () => {
    const result = commandRequestSchema.safeParse({
      type: "command.request",
      commandId: "cmd-1",
      deviceId: "device-1",
      tool: "system.info",
      arguments: {},
      createdAt: "2026-09-14T08:00:00.000Z",
    });

    expect(result.success).toBe(true);
  });

  test("rejects an empty device id", () => {
    const result = commandRequestSchema.safeParse({
      type: "command.request",
      commandId: "cmd-1",
      deviceId: "",
      tool: "system.info",
      arguments: {},
      createdAt: "2026-09-14T08:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });
});
