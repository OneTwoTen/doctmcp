import { describe, expect, test } from "bun:test";
import { pairingChannelMessageSchema } from "./pairing-control";

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREDENTIAL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CHANNEL_PROOF = "A".repeat(43);
const DEVICE_CREDENTIAL = "B".repeat(43);

describe("pairing channel control-plane schema", () => {
  test("accepts attach, attached, credential, acknowledgement, error and close frames", () => {
    const frames = [
      {
        kind: "pairing.attach",
        pairingSessionId: SESSION_ID,
        channelProof: CHANNEL_PROOF,
      },
      {
        kind: "pairing.attached",
        pairingSessionId: SESSION_ID,
        expiresAt: "2026-09-18T12:00:00.000Z",
      },
      {
        kind: "pairing.credential",
        pairingSessionId: SESSION_ID,
        deviceId: DEVICE_ID,
        credentialId: CREDENTIAL_ID,
        version: 1,
        credential: DEVICE_CREDENTIAL,
      },
      {
        kind: "pairing.ack",
        pairingSessionId: SESSION_ID,
        deviceId: DEVICE_ID,
        credentialId: CREDENTIAL_ID,
        version: 1,
      },
      { kind: "pairing.error", code: "PAIRING_UNAVAILABLE" },
      { kind: "pairing.close", code: "NORMAL" },
    ];

    for (const frame of frames) {
      expect(pairingChannelMessageSchema.safeParse(frame).success).toBe(true);
    }
  });

  test("canonicalizes the pairing session id but rejects malformed identities", () => {
    const parsed = pairingChannelMessageSchema.safeParse({
      kind: "pairing.attach",
      pairingSessionId: SESSION_ID.toUpperCase(),
      channelProof: CHANNEL_PROOF,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind === "pairing.attach") {
      expect(parsed.data.pairingSessionId).toBe(SESSION_ID);
    }

    expect(
      pairingChannelMessageSchema.safeParse({
        kind: "pairing.attach",
        pairingSessionId: "not-a-uuid",
        channelProof: CHANNEL_PROOF,
      }).success,
    ).toBe(false);
  });

  test("rejects malformed secrets, credential generations and unknown fields", () => {
    const invalidFrames = [
      {
        kind: "pairing.attach",
        pairingSessionId: SESSION_ID,
        channelProof: `${CHANNEL_PROOF}=`,
      },
      {
        kind: "pairing.credential",
        pairingSessionId: SESSION_ID,
        deviceId: DEVICE_ID,
        credentialId: CREDENTIAL_ID,
        version: 1,
        credential: "secret",
      },
      {
        kind: "pairing.ack",
        pairingSessionId: SESSION_ID,
        deviceId: DEVICE_ID,
        credentialId: CREDENTIAL_ID,
        version: 0,
      },
      {
        kind: "pairing.attach",
        pairingSessionId: SESSION_ID,
        channelProof: CHANNEL_PROOF,
        ownerId: "caller-controlled",
      },
      { kind: "pairing.unknown" },
    ];

    for (const frame of invalidFrames) {
      expect(pairingChannelMessageSchema.safeParse(frame).success).toBe(false);
    }
  });

  test("exposes only bounded generic error and close codes", () => {
    expect(
      pairingChannelMessageSchema.safeParse({
        kind: "pairing.error",
        code: "PAIRING_UNAVAILABLE",
      }).success,
    ).toBe(true);
    expect(
      pairingChannelMessageSchema.safeParse({
        kind: "pairing.error",
        code: "credential-was-secret-value",
      }).success,
    ).toBe(false);
    expect(
      pairingChannelMessageSchema.safeParse({
        kind: "pairing.close",
        code: "NORMAL",
        credential: DEVICE_CREDENTIAL,
      }).success,
    ).toBe(false);
  });
});
