import { z } from "zod";

export const deviceIdSchema = z.string().min(1).max(128);
export const commandIdSchema = z.string().min(1).max(128);
export const toolNameSchema = z.string().min(1).max(128);

export const commandRequestSchema = z.object({
  type: z.literal("command.request"),
  commandId: commandIdSchema,
  deviceId: deviceIdSchema,
  tool: toolNameSchema,
  arguments: z.unknown(),
  createdAt: z.iso.datetime(),
});
