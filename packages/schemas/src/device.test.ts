import { describe, expect, test } from "bun:test";
import {
  createDeviceInputSchema,
  deviceIdSchema,
  updateDeviceInputSchema,
} from "./device";

describe("device schemas", () => {
  test("accepts UUID v4, canonicalizes identity và normalizes mutable display input", () => {
    expect(deviceIdSchema.parse("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")).toBe(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );

    const input = createDeviceInputSchema.parse({
      ownerId: "owner-a",
      deviceName: "  DoCT-MAC  ",
      metadata: {
        platform: "darwin-arm64",
        appVersion: "1.4.2",
        runtimeVersion: "bun-1.4.2",
      },
    });

    expect(input.deviceName).toBe("DoCT-MAC");
  });

  test("rejects non-v4 device id and malformed metadata", () => {
    expect(deviceIdSchema.safeParse("0199-opaque-but-not-a-uuid").success).toBe(
      false,
    );

    expect(
      createDeviceInputSchema.safeParse({
        ownerId: "owner-a",
        deviceName: "Laptop",
        metadata: {
          platform: "",
          credential: "must-not-live-in-device-metadata",
        },
      }).success,
    ).toBe(false);
  });

  test("rejects empty update patch", () => {
    expect(updateDeviceInputSchema.safeParse({}).success).toBe(false);
  });
});
