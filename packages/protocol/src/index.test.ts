import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type CommandRequest } from "./index";

describe("protocol", () => {
  test("starts at protocol version 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  test("represents a generic local tool command", () => {
    const command: CommandRequest = {
      type: "command.request",
      commandId: "cmd-1",
      deviceId: "device-1",
      tool: "filesystem.read",
      arguments: { path: "/tmp/example.txt" },
      createdAt: "2026-09-14T08:00:00.000Z",
    };

    expect(command.tool).toBe("filesystem.read");
    expect(command.deviceId).toBe("device-1");
  });
});
