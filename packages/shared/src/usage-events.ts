import { z } from "zod";

export const UsageEvent = z.object({
  id: z.string().uuid(),
  issueId: z.string().uuid(),
  workerSessionId: z.string().uuid(),
  role: z.enum(["developer", "reviewer", "legacy"]),
  runtime: z.string().nullable(),
  tokensIn: z.number().int().nullable(),
  tokensOut: z.number().int().nullable(),
  costUsd: z.number().nullable(),
  durationMs: z.number().int().nullable(),
  ts: z.string(),
});
export type UsageEvent = z.infer<typeof UsageEvent>;
