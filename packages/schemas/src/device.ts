import { z } from "zod";

const DEVICE_ID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DEVICE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/;

/**
 * M3 dùng UUID v4 ngẫu nhiên cho deviceId. Caller phải coi giá trị này là opaque
 * và không dựa vào format để authorization hoặc suy ra thứ tự tạo thiết bị.
 * UUID hợp lệ được canonicalize về lowercase để một identity chỉ có một representation.
 */
export const deviceIdSchema = z
  .string()
  .regex(DEVICE_ID_V4_PATTERN, "deviceId phải là UUID v4 hợp lệ")
  .transform((value) => value.toLowerCase());

/** ownerId là principal opaque do control-plane đáng tin cậy cung cấp trong M3. */
export const ownerIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value, {
    message: "ownerId không được có khoảng trắng ở đầu/cuối",
  });

export const deviceNameSchema = z.string().trim().min(1).max(100);

export const devicePlatformSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(DEVICE_IDENTIFIER_PATTERN, "platform không hợp lệ");

export const deviceVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(DEVICE_VERSION_PATTERN, "version không hợp lệ");

export const deviceMetadataSchema = z
  .object({
    platform: devicePlatformSchema,
    appVersion: deviceVersionSchema.optional(),
    runtimeVersion: deviceVersionSchema.optional(),
  })
  .strict();

export const createDeviceInputSchema = z
  .object({
    ownerId: ownerIdSchema,
    deviceName: deviceNameSchema,
    metadata: deviceMetadataSchema,
  })
  .strict();

export const updateDeviceInputSchema = z
  .object({
    deviceName: deviceNameSchema.optional(),
    metadata: deviceMetadataSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.deviceName !== undefined || value.metadata !== undefined,
    { message: "Device update phải thay đổi ít nhất một field mutable" },
  );

export const deviceSchema = z
  .object({
    deviceId: deviceIdSchema,
    ownerId: ownerIdSchema,
    deviceName: deviceNameSchema,
    metadata: deviceMetadataSchema,
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict()
  .refine((value) => value.updatedAt.getTime() >= value.createdAt.getTime(), {
    message: "updatedAt không được trước createdAt",
  });

type ParsedDeviceMetadata = z.infer<typeof deviceMetadataSchema>;
type ParsedDevice = z.infer<typeof deviceSchema>;

export type DeviceMetadata = Readonly<ParsedDeviceMetadata>;
export type CreateDeviceInput = Readonly<
  z.infer<typeof createDeviceInputSchema>
>;
export type UpdateDeviceInput = Readonly<
  z.infer<typeof updateDeviceInputSchema>
>;
export type Device = Readonly<
  Omit<ParsedDevice, "metadata"> & { metadata: DeviceMetadata }
>;
