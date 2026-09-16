import { z } from "zod";
import { deviceIdSchema, ownerIdSchema } from "./device";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 32 random bytes encoded as unpadded base64url always occupy 43 characters. */
export const DEVICE_CREDENTIAL_SECRET_BASE64URL_LENGTH = 43 as const;

export const deviceCredentialSecretSchema = z
  .string()
  .length(
    DEVICE_CREDENTIAL_SECRET_BASE64URL_LENGTH,
    `credential phải dài đúng ${DEVICE_CREDENTIAL_SECRET_BASE64URL_LENGTH} ký tự base64url`,
  )
  .regex(BASE64URL_PATTERN, "credential phải là unpadded base64url hợp lệ");

export const deviceCredentialIdSchema = z
  .string()
  .regex(UUID_V4_PATTERN, "credentialId phải là UUID v4 hợp lệ")
  .transform((value) => value.toLowerCase());

export const deviceCredentialStateSchema = z.enum(["active", "revoked"]);

export const deviceCredentialSchema = z
  .object({
    credentialId: deviceCredentialIdSchema,
    version: z.number().int().positive(),
    deviceId: deviceIdSchema,
    state: deviceCredentialStateSchema,
    createdAt: z.date(),
    revokedAt: z.date().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.state === "active" && value.revokedAt !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Credential active không được có revokedAt",
      });
    }
    if (value.state === "revoked" && value.revokedAt === undefined) {
      context.addIssue({
        code: "custom",
        message: "Credential revoked phải có revokedAt",
      });
    }
    if (
      value.revokedAt !== undefined &&
      value.revokedAt.getTime() < value.createdAt.getTime()
    ) {
      context.addIssue({
        code: "custom",
        message: "revokedAt không được trước createdAt",
      });
    }
  });

export const authenticatedDeviceIdentitySchema = z
  .object({
    ownerId: ownerIdSchema,
    deviceId: deviceIdSchema,
  })
  .strict();

export type DeviceCredentialSecret = z.infer<
  typeof deviceCredentialSecretSchema
>;
export type DeviceCredentialId = z.infer<typeof deviceCredentialIdSchema>;
export type DeviceCredentialState = z.infer<typeof deviceCredentialStateSchema>;
export type DeviceCredential = Readonly<z.infer<typeof deviceCredentialSchema>>;
export type AuthenticatedDeviceIdentity = Readonly<
  z.infer<typeof authenticatedDeviceIdentitySchema>
>;
