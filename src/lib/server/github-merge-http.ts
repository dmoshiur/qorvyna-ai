import "server-only";
import { z } from "zod";
export const mergeInputSchema = z.object({ repository: z.string().min(3).max(200), number: z.number().int().min(1).max(1_000_000_000) });
export const mergeExecuteSchema = mergeInputSchema.extend({ reviewToken: z.string().min(1).max(2048) });
