import { describe, expect, test } from "bun:test";
import {
  createDeviceCredentialInvalidationEvent,
  InMemoryDeviceCredentialInvalidationBus,
} from "./device-credential-invalidation";

const EVENT = createDeviceCredentialInvalidationEvent({
  eventId: "event-1",
  kind: "rotated",
  deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  credentialId: "11111111-1111-4111-8111-111111111111",
  credentialVersion: 2,
  publishedAt: new Date("2026-09-16T00:00:00.000Z"),
});

describe("DeviceCredentialInvalidationBus", () => {
  test("event only carries generation metadata and never raw credential material", () => {
    expect(EVENT).toEqual({
      eventId: "event-1",
      kind: "rotated",
      deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      credentialId: "11111111-1111-4111-8111-111111111111",
      credentialVersion: 2,
      publishedAt: "2026-09-16T00:00:00.000Z",
    });
    expect("credential" in EVENT).toBe(false);
    expect("secret" in EVENT).toBe(false);
  });

  test("one synchronous subscriber failure does not prevent delivery to later subscribers", async () => {
    const bus = new InMemoryDeviceCredentialInvalidationBus();
    const deliveries: string[] = [];
    bus.subscribe(() => {
      deliveries.push("first");
      throw new Error("subscriber failed");
    });
    bus.subscribe(() => {
      deliveries.push("second");
    });

    await expect(bus.publish(EVENT)).rejects.toThrow(
      "Credential invalidation subscriber xử lý thất bại.",
    );
    expect(deliveries).toEqual(["first", "second"]);
  });

  test("unsubscribe is idempotent and stops future delivery", async () => {
    const bus = new InMemoryDeviceCredentialInvalidationBus();
    let deliveries = 0;
    const unsubscribe = bus.subscribe(() => {
      deliveries += 1;
    });

    unsubscribe();
    unsubscribe();
    await bus.publish(EVENT);

    expect(deliveries).toBe(0);
  });
});
