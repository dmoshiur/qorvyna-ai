import "server-only";
import { z } from "zod";
export const prInputSchema = z.object({
  repository: z.string().min(3).max(200),
  base: z.string().min(1).max(180),
  head: z.string().min(1).max(180),
  title: z.string().min(1).max(160),
  body: z.string().max(10_000),
});
export const prCreateSchema = prInputSchema.extend({ reviewToken: z.string().min(1).max(2048) });
