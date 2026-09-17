import type { HumanAction, HumanActionType } from "@agent-dealer/shared";

/**
 * Generic rendering helpers for human actions, shared by the Issues home "Needs your
 * attention" panel and Issue Detail (NOT-71). Nothing here branches on action type to
 * decide *what* can be done — the choices always come from the server's own
 * `responseOptionsJson`, so a new action type surfaces correctly without a UI change.
 */

export const ACTION_LABELS: Record<HumanActionType, string> = {
  final_review: "Final review",
  attempts_exhausted: "Attempts exhausted",
  policy_escalation: "Policy escalation",
  product_scope_decision: "Product scope decision",
  deck_interaction_required: "Agent Deck interaction required",
  reflection_interaction_required: "Reflection interaction required",
  outbound_delivery_interaction_required: "Outbound delivery interaction required",
};

export function actionLabel(actionType: HumanActionType): string {
  return ACTION_LABELS[actionType] ?? actionType;
}

export type ResponseOption = { choice: string; label: string };

function parseJson<T>(json: string | null | undefined): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/** The server-declared choices for an action — empty when it declares none. */
export function parseResponseOptions(action: HumanAction): ResponseOption[] {
  const parsed = parseJson<ResponseOption[]>(action.responseOptionsJson);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((o) => typeof o?.choice === "string" && typeof o?.label === "string");
}

/**
 * One-line context summaries from an action's evidence / continuation preview — enough to
 * judge a choice without leaving the list. Returns [] when the action carries neither.
 */
export function actionContextLines(action: HumanAction): string[] {
  const lines: string[] = [];
  const evidence = parseJson<{
    review?: { verdict?: string; findings?: unknown[] };
    serviceId?: string;
    toolName?: string;
  }>(action.evidenceJson);
  const continuation = parseJson<{ resumeRole?: string; resumeHeadSha?: string | null }>(
    action.continuationPreviewJson
  );

  if (evidence?.review?.verdict) {
    const findings = Array.isArray(evidence.review.findings) ? evidence.review.findings.length : 0;
    lines.push(
      `Reviewer verdict: ${evidence.review.verdict}${findings ? ` · ${findings} finding(s)` : ""}`
    );
  }
  if (evidence?.serviceId || evidence?.toolName) {
    lines.push(`Delivery: ${[evidence.serviceId, evidence.toolName].filter(Boolean).join(" · ")}`);
  }
  if (continuation?.resumeRole) {
    lines.push(
      `Continuation: resumes as ${continuation.resumeRole}${
        continuation.resumeHeadSha ? ` at ${continuation.resumeHeadSha.slice(0, 8)}` : ""
      }`
    );
  }
  return lines;
}

/** Destructive-looking choices get the danger treatment instead of the primary one. */
export function isDestructiveChoice(choice: string): boolean {
  return choice === "close" || choice === "reject" || choice === "abort";
}
