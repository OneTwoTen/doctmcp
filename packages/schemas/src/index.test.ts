import { describe, expect, test } from "bun:test";
import { agentHelloSchema, deviceIdSchema, heartbeatSchema } from "./index";

describe("control plane schemas", () => {
  test("accepts a valid agent hello", () => {
    const result = agentHelloSchema.safeParse({
      type: "agent.hello",
      protocolVersion: 1,
      deviceId: "device-1",
      agentVersion: "0.1.0",
    });

    expect(result.success).toBe(true);
  });

  test("rejects an empty device id", () => {
    const result = deviceIdSchema.safeParse("");
    expect(result.success).toBe(false);
  });

  test("accepts a valid heartbeat", () => {
    const result = heartbeatSchema.safeParse({
      type: "heartbeat",
      timestamp: "2026-09-14T08:00:00.000Z",
    });

    expect(result.success).toBe(true);
  });
});
