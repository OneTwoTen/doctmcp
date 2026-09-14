import { z } from "zod";

export const deviceIdSchema = z.string().min(1).max(128);
