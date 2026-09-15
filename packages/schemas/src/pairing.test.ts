import { describe, expect, test } from "bun:test";
import {
  claimPairingInputSchema,
  createPairingSessionInputSchema,
  pairingSessionIdSchema,
  pairingSessionSchema,
} from "./pairing";

const SESSION_ID = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const DEVICE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREATED_AT = new Date("2026-09-15T06:00:00.000Z");
const EXPIRES_AT = new Date("2026-09-15T06:05:00.000Z");

describe("pairing schemas", () => {
  test("pairingSessionId canonicalize UUID v4 về lowercase", () => {
    expect(pairingSessionIdSchema.parse(SESSION_ID)).toBe(
      SESSION_ID.toLowerCase(),
    );
  });

  test("pending session không được mang claimed identity", () => {
    expect(
      pairingSessionSchema.safeParse({
        pairingSessionId: SESSION_ID,
        state: "pending",
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
        deviceId: DEVICE_ID,
      }).success,
    ).toBe(false);
  });

  test("claimed session bắt buộc có deviceId + claimedAt trong TTL", () => {
    expect(
      pairingSessionSchema.safeParse({
        pairingSessionId: SESSION_ID,
        state: "claimed",
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
        claimedAt: new Date("2026-09-15T06:01:00.000Z"),
        deviceId: DEVICE_ID,
      }).success,
    ).toBe(true);

    expect(
      pairingSessionSchema.safeParse({
        pairingSessionId: SESSION_ID,
        state: "claimed",
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
        claimedAt: EXPIRES_AT,
        deviceId: DEVICE_ID,
      }).success,
    ).toBe(false);
  });

  test("create/claim inputs giữ correlation và owner/device metadata boundary", () => {
    expect(
      createPairingSessionInputSchema.parse({
        localCorrelationId: "local-runtime-1",
      }),
    ).toEqual({ localCorrelationId: "local-runtime-1" });

    expect(
      claimPairingInputSchema.safeParse({
        ownerId: "owner-a",
        deviceName: "DoCT-MAC",
        metadata: { platform: "" },
      }).success,
    ).toBe(false);
  });
});
