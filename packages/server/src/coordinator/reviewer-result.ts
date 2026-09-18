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

/** Stable fingerprint for coordinator-injected incomplete-review findings (truncated diff). */
export const INCOMPLETE_REVIEW_FINGERPRINT = "diff-truncated-incomplete-review";

/** Stable fingerprint when bare escalate is remapped without a product question (NOT-150). */
export const BARE_ESCALATE_REMAP_FINGERPRINT = "escalated-without-product-scope-question";

/**
 * Enforce PRD §6.4 / design NOT-150 invariants:
 * - `escalated` requires a non-empty `productScopeQuestion` (else remap to `changes_requested`
 *   with a blocking finding — never empty-findings repair)
 * - any `blocking` finding forbids `approved` (remap to `changes_requested`)
 * - bare escalate is never a valid routing input (avoids Resume|Close `policy_escalation`)
 */
export function normalizeReviewerResult(raw: ReviewerResult): ReviewerResult {
  const hasBlocking = raw.findings.some((f) => f.severity === "blocking");
  const question = raw.productScopeQuestion?.trim() || undefined;

  if (raw.verdict === "escalated") {
    if (question) {
      return { ...raw, productScopeQuestion: question };
    }
    const { productScopeQuestion: _drop, ...rest } = raw;
    if (hasBlocking) {
      return { ...rest, verdict: "changes_requested" };
    }
    return {
      ...rest,
      verdict: "changes_requested",
      findings: [
        ...raw.findings,
        {
          fingerprint: BARE_ESCALATE_REMAP_FINGERPRINT,
          severity: "blocking",
          title: "Escalated without a product scope question",
          rationale:
            "Reviewer returned escalated without productScopeQuestion. Remapped to changes_requested so a coding repair can proceed; escalate only for true product ambiguity with a concrete question.",
        },
      ],
    };
  }

  // Drop a stray productScopeQuestion on non-escalate verdicts.
  const withoutQuestion = question
    ? (() => {
        const { productScopeQuestion: _drop, ...rest } = raw;
        return rest;
      })()
    : raw;

  if (withoutQuestion.verdict === "approved" && hasBlocking) {
    return { ...withoutQuestion, verdict: "changes_requested" };
  }

  return withoutQuestion;
}

/** Mirrors the plan-triage/reflect JSON-fence parsing pattern already used elsewhere. */
export function parseReviewerResult(text: string): ReviewerResult | null {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidates = [fenceMatch?.[1] ?? trimmed, trimmed];
  for (const candidate of candidates) {
    try {
      const parsed = ReviewerResult.safeParse(JSON.parse(candidate));
      if (parsed.success) return normalizeReviewerResult(parsed.data);
    } catch {
      // try next candidate
    }
  }
  return null;
}
