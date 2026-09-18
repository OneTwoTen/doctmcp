import { z } from "zod";
import { deviceIdSchema } from "./device";
import {
  deviceCredentialIdSchema,
  deviceCredentialSecretSchema,
} from "./device-credential";
import { pairingSessionIdSchema } from "./pairing";

export const PAIRING_CHANNEL_MAX_MESSAGE_BYTES = 4_096 as const;

export const pairingChannelProofSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]{43}$/);

export const pairingChannelErrorCodeSchema = z.enum([
  "PAIRING_UNAVAILABLE",
  "PAIRING_RATE_LIMITED",
  "PAIRING_STORAGE_FAILED",
  "PROTOCOL_ERROR",
  "TIMEOUT",
  "SERVER_SHUTDOWN",
]);

export const pairingChannelCloseCodeSchema = z.enum([
  "NORMAL",
  "PROTOCOL_ERROR",
  "TIMEOUT",
  "SERVER_SHUTDOWN",
]);

const pairingAttachSchema = z
  .object({
    kind: z.literal("pairing.attach"),
    pairingSessionId: pairingSessionIdSchema,
    channelProof: pairingChannelProofSchema,
  })
  .strict();

const pairingAttachedSchema = z
  .object({
    kind: z.literal("pairing.attached"),
    pairingSessionId: pairingSessionIdSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();

const pairingCredentialSchema = z
  .object({
    kind: z.literal("pairing.credential"),
    pairingSessionId: pairingSessionIdSchema,
    deviceId: deviceIdSchema,
    credentialId: deviceCredentialIdSchema,
    version: z.number().int().positive(),
    credential: deviceCredentialSecretSchema,
  })
  .strict();

const pairingAckSchema = z
  .object({
    kind: z.literal("pairing.ack"),
    pairingSessionId: pairingSessionIdSchema,
    deviceId: deviceIdSchema,
    credentialId: deviceCredentialIdSchema,
    version: z.number().int().positive(),
  })
  .strict();

const pairingErrorSchema = z
  .object({
    kind: z.literal("pairing.error"),
    code: pairingChannelErrorCodeSchema,
  })
  .strict();

const pairingCloseSchema = z
  .object({
    kind: z.literal("pairing.close"),
    code: pairingChannelCloseCodeSchema,
  })
  .strict();

export const pairingChannelMessageSchema = z.discriminatedUnion("kind", [
  pairingAttachSchema,
  pairingAttachedSchema,
  pairingCredentialSchema,
  pairingAckSchema,
  pairingErrorSchema,
  pairingCloseSchema,
]);

export type PairingChannelMessage = z.infer<typeof pairingChannelMessageSchema>;
export type PairingChannelErrorCode = z.infer<
  typeof pairingChannelErrorCodeSchema
>;
export type PairingChannelCloseCode = z.infer<
  typeof pairingChannelCloseCodeSchema
>;
