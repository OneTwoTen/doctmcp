import { describe, expect, test } from "bun:test";
import * as protocol from "./index";
import { type AgentHello, type Heartbeat, PROTOCOL_VERSION } from "./index";

describe("protocol", () => {
  test("starts at protocol version 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  test("supports control-plane messages", () => {
    const hello: AgentHello = {
      type: "agent.hello",
      protocolVersion: PROTOCOL_VERSION,
      deviceId: "device-1",
      agentVersion: "0.1.0",
    };

    const heartbeat: Heartbeat = {
      type: "heartbeat",
      timestamp: "2026-09-14T08:00:00.000Z",
    };

    expect(hello.type).toBe("agent.hello");
    expect(heartbeat.type).toBe("heartbeat");
  });

  test("does not export tool-execution RPC envelope", () => {
    // biome-ignore lint/suspicious/noExplicitAny: verify exports at runtime
    const exported = protocol as Record<string, any>;
    expect(exported.CommandRequest).toBeUndefined();
    expect(exported.CommandResult).toBeUndefined();
    expect(exported.CommandError).toBeUndefined();
  });
});
