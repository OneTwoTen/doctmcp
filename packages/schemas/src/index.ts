import { z } from "zod";

export const deviceIdSchema = z.string().min(1).max(128);

export const agentHelloSchema = z.object({
  type: z.literal("agent.hello"),
  protocolVersion: z.literal(1),
  deviceId: deviceIdSchema,
  agentVersion: z.string().min(1),
});

export const heartbeatSchema = z.object({
  type: z.literal("heartbeat"),
  timestamp: z.iso.datetime(),
});
