import { z } from "zod";
import {
  deviceIdSchema,
  deviceMetadataSchema,
  deviceNameSchema,
  ownerIdSchema,
} from "./device";

const PAIRING_SESSION_ID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Opaque identity của một pairing attempt. Đây không phải deviceId, bridge session id
 * hoặc credential và caller không được suy ra authorization từ format UUID.
 */
export const pairingSessionIdSchema = z
  .string()
  .regex(
    PAIRING_SESSION_ID_V4_PATTERN,
    "pairingSessionId phải là UUID v4 hợp lệ",
  )
  .transform((value) => value.toLowerCase());

export const pairingStateSchema = z.enum([
  "pending",
  "claimed",
  "expired",
  "cancelled",
]);

export const pairingCorrelationIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value, {
    message: "localCorrelationId không được có khoảng trắng ở đầu/cuối",
  });

export const createPairingSessionInputSchema = z
  .object({
    localCorrelationId: pairingCorrelationIdSchema.optional(),
  })
  .strict();

export const claimPairingInputSchema = z
  .object({
    ownerId: ownerIdSchema,
    deviceName: deviceNameSchema,
    metadata: deviceMetadataSchema,
  })
  .strict();

export const pairingSessionSchema = z
  .object({
    pairingSessionId: pairingSessionIdSchema,
    state: pairingStateSchema,
    createdAt: z.date(),
    expiresAt: z.date(),
    localCorrelationId: pairingCorrelationIdSchema.optional(),
    claimedAt: z.date().optional(),
    deviceId: deviceIdSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const createdAtMs = value.createdAt.getTime();
    const expiresAtMs = value.expiresAt.getTime();

    if (!Number.isFinite(createdAtMs) || !Number.isFinite(expiresAtMs)) {
      context.addIssue({
        code: "custom",
        message: "Pairing timestamps phải hợp lệ",
      });
      return;
    }

    if (expiresAtMs <= createdAtMs) {
      context.addIssue({
        code: "custom",
        message: "expiresAt phải sau createdAt",
      });
    }

    if (value.state === "claimed") {
      if (value.claimedAt === undefined || value.deviceId === undefined) {
        context.addIssue({
          code: "custom",
          message: "Pairing claimed phải có claimedAt và deviceId",
        });
        return;
      }

      const claimedAtMs = value.claimedAt.getTime();
      if (
        !Number.isFinite(claimedAtMs) ||
        claimedAtMs < createdAtMs ||
        claimedAtMs >= expiresAtMs
      ) {
        context.addIssue({
          code: "custom",
          message: "claimedAt phải nằm trong thời gian pairing còn hiệu lực",
        });
      }
      return;
    }

    if (value.claimedAt !== undefined || value.deviceId !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Pairing chưa claimed không được có claimedAt hoặc deviceId",
      });
    }
  });

export type PairingSessionId = z.infer<typeof pairingSessionIdSchema>;
export type PairingState = z.infer<typeof pairingStateSchema>;
export type CreatePairingSessionInput = Readonly<
  z.infer<typeof createPairingSessionInputSchema>
>;
export type ClaimPairingInput = Readonly<
  z.infer<typeof claimPairingInputSchema>
>;
export type PairingSession = Readonly<z.infer<typeof pairingSessionSchema>>;
