import { z } from "zod";

export const ReviewerVerdict = z.enum(["approved", "changes_requested", "escalated"]);
export type ReviewerVerdict = z.infer<typeof ReviewerVerdict>;

export const ReviewerFinding = z.object({
  fingerprint: z.string(),
  severity: z.enum(["blocking", "non_blocking"]),
  title: z.string(),
  rationale: z.string(),
  file: z.string().optional(),
  line: z.number().int().optional(),
});
export type ReviewerFinding = z.infer<typeof ReviewerFinding>;

export const ReviewerResult = z.object({
  verdict: ReviewerVerdict,
  baseSha: z.string(),
  headSha: z.string(),
  acceptanceCriteriaAssessment: z.string(),
  evidenceAssessment: z.string(),
  findings: z.array(ReviewerFinding),
  risks: z.array(z.string()),
  /** Present only when verdict is "escalated" and the reviewer identifies a missing product call. */
  productScopeQuestion: z.string().optional(),
});
export type ReviewerResult = z.infer<typeof ReviewerResult>;

/** Mirrors the plan-triage/reflect JSON-fence parsing pattern already used elsewhere. */
export function parseReviewerResult(text: string): ReviewerResult | null {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidates = [fenceMatch?.[1] ?? trimmed, trimmed];
  for (const candidate of candidates) {
    try {
      const parsed = ReviewerResult.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // try next candidate
    }
  }
  return null;
}
