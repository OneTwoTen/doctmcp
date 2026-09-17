import { describe, expect, test } from "bun:test";
import type { BridgeMessage } from "@doctmcp/protocol";
import { DeviceSessionRegistry } from "./device-session-registry";
import type { BridgeGatewaySession } from "./gateway";

const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GENERATION_1 = {
  credentialId: "11111111-1111-4111-8111-111111111111",
  credentialVersion: 1,
} as const;
const GENERATION_2 = {
  credentialId: "22222222-2222-4222-8222-222222222222",
  credentialVersion: 2,
} as const;

function createSession(input: {
  id: string;
  deviceId: string;
  ownerId?: string;
}): BridgeGatewaySession {
  let state: BridgeGatewaySession["state"] = "ready";
  const session: BridgeGatewaySession = {
    id: input.id,
    get state() {
      return state;
    },
    identity: {
      ownerId: input.ownerId ?? "owner-a",
      deviceId: input.deviceId,
    },
    onmessage: undefined,
    onclose: undefined,
    async send(_message: BridgeMessage) {},
    async close(code = "NORMAL") {
      if (state === "closed") return;
      state = "closed";
      session.onclose?.(code);
    },
  };
  return session;
}

describe("DeviceSessionRegistry", () => {
  test("registers authenticated session and supports device/owner lookup", () => {
    const registry = new DeviceSessionRegistry();
    const session = createSession({ id: "session-a", deviceId: DEVICE_A });

    registry.register(session, GENERATION_1);

    const active = registry.getActive(DEVICE_A);
    expect(active?.session).toBe(session);
    expect(active?.credentialGeneration).toEqual(GENERATION_1);
    expect(registry.listActiveForOwner("owner-a")).toHaveLength(1);
    expect(registry.getStatus(DEVICE_A).status).toBe("online");
  });

  test("new session replaces old atomically and old cleanup cannot evict new session", () => {
    let registrationSequence = 0;
    const registry = new DeviceSessionRegistry({
      generateRegistrationId: () => `registration-${++registrationSequence}`,
    });
    const oldSession = createSession({ id: "old", deviceId: DEVICE_A });
    const newSession = createSession({ id: "new", deviceId: DEVICE_A });

    registry.register(oldSession, GENERATION_1);
    const replacement = registry.register(newSession, GENERATION_1);

    expect(replacement.replaced?.session).toBe(oldSession);
    expect(registry.getActive(DEVICE_A)?.session).toBe(newSession);
    expect(registry.evictSession(oldSession)).toBeNull();
    expect(registry.getActive(DEVICE_A)?.session).toBe(newSession);
  });

  test("heartbeat is bound to exact session and cannot mutate another device", () => {
    let nowMs = Date.parse("2026-09-16T00:00:00.000Z");
    const registry = new DeviceSessionRegistry({
      heartbeatTimeoutMs: 100,
      now: () => new Date(nowMs),
    });
    const sessionA = createSession({ id: "a", deviceId: DEVICE_A });
    const sessionB = createSession({ id: "b", deviceId: DEVICE_B });
    registry.register(sessionA, GENERATION_1);
    registry.register(sessionB, GENERATION_1);

    nowMs += 80;
    expect(registry.markHeartbeat(sessionA)).toBe(true);
    nowMs += 30;

    expect(registry.getStatus(DEVICE_A).status).toBe("online");
    expect(registry.getStatus(DEVICE_B).status).toBe("offline");
  });

  test("heartbeat at timeout boundary cannot revive a stale session", () => {
    let nowMs = Date.parse("2026-09-16T00:00:00.000Z");
    const registry = new DeviceSessionRegistry({
      heartbeatTimeoutMs: 100,
      now: () => new Date(nowMs),
    });
    const session = createSession({ id: "stale", deviceId: DEVICE_A });
    registry.register(session, GENERATION_1);

    nowMs += 100;

    expect(registry.getStatus(DEVICE_A).status).toBe("offline");
    expect(registry.markHeartbeat(session)).toBe(false);
    expect(registry.getStatus(DEVICE_A).lastSeenAt?.getTime()).toBe(
      Date.parse("2026-09-16T00:00:00.000Z"),
    );
  });

  test("delayed invalidation only evicts the exact credential generation", () => {
    const registry = new DeviceSessionRegistry();
    const oldSession = createSession({ id: "old", deviceId: DEVICE_A });
    const newSession = createSession({ id: "new", deviceId: DEVICE_A });
    registry.register(oldSession, GENERATION_1);
    registry.register(newSession, GENERATION_2);

    expect(registry.evictGeneration(DEVICE_A, GENERATION_1)).toBeNull();
    expect(registry.getActive(DEVICE_A)?.session).toBe(newSession);

    const evicted = registry.evictGeneration(DEVICE_A, GENERATION_2);
    expect(evicted?.session).toBe(newSession);
    expect(registry.getStatus(DEVICE_A).status).toBe("offline");
  });

  test("status snapshot exposes liveness only and clear is idempotent", () => {
    const registry = new DeviceSessionRegistry();
    const session = createSession({ id: "session-a", deviceId: DEVICE_A });
    registry.register(session, GENERATION_1);

    const status = registry.getStatus(DEVICE_A);
    expect(status).toEqual({
      deviceId: DEVICE_A,
      status: "online",
      connectedAt: expect.any(Date),
      lastSeenAt: expect.any(Date),
    });
    expect("credentialId" in status).toBe(false);
    expect("session" in status).toBe(false);

    expect(registry.clear()).toHaveLength(1);
    expect(registry.clear()).toHaveLength(0);
    expect(registry.getStatus(DEVICE_A).status).toBe("offline");
  });
});
