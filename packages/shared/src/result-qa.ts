import { z } from "zod";

export const ResultQaStatus = z.enum(["pending", "answered", "failed"]);
export type ResultQaStatus = z.infer<typeof ResultQaStatus>;

/** result_qa artifact contentJson. Append-only: latest artifact per exchangeId wins. */
export const ResultQaContent = z.object({
  exchangeId: z.string().min(1),
  question: z.string().min(1).max(2000),
  answer: z.string().optional(),
  status: ResultQaStatus,
  /** false when the execute session was gone and the answer came from artifacts. */
  sessionResumed: z.boolean(),
  askedAt: z.string(),
  answeredAt: z.string().optional(),
  error: z.string().optional(),
});
export type ResultQaContent = z.infer<typeof ResultQaContent>;

/** POST /api/runs/:id/qa body. */
export const ResultQaInput = z.object({
  question: z.string().min(1).max(2000),
});
export type ResultQaInput = z.infer<typeof ResultQaInput>;

/** Fixed v1 cap — answering is cheaper than planning (half the plan-draft cap). */
export const QA_PHASE_BUDGET = { maxTurns: 6, maxBudgetUsd: 0.25 } as const;

/** Collapse append-only exchanges: last artifact per exchangeId, ordered by askedAt. */
export function latestQaExchanges(contents: ResultQaContent[]): ResultQaContent[] {
  const byId = new Map<string, ResultQaContent>();
  for (const c of contents) byId.set(c.exchangeId, c);
  return [...byId.values()].sort((a, b) => a.askedAt.localeCompare(b.askedAt));
}
