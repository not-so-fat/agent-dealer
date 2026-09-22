import type { LinearCandidate, LinearRepoResolution } from "@agent-dealer/shared";
import { parseGitHubRepoInput, resolveLinearRepoLabels } from "@agent-dealer/shared";

/**
 * NOT-251: Linear repository intake without a confirmation gate.
 *
 * The New issue form has exactly one ordinary repository input. A Linear
 * ticket's `repo:` label is an auto-fill hint only:
 *
 * - Exactly one valid `repo:` label silently pre-fills the input.
 * - Anything else (no label, conflicting labels, invalid value) preserves
 *   whatever is already in the input — never clears it, never adds a step.
 * - The operator overrides by typing or selecting a recent repository in
 *   the same input; the new valid value takes effect immediately.
 *
 * Only conflicting/invalid labels produce UI: a compact inline warning
 * below the control. A valid manually entered repository stays submittable.
 */

/** Canonical `github.com/<owner>/<repo>` for display and comparison, or null. */
export function canonicalRepoIdentity(raw: string): string | null {
  try {
    return parseGitHubRepoInput(raw).identity;
  } catch {
    return null;
  }
}

/**
 * The repository hint for the form: the server-resolved `repoResolution` when
 * present, recomputed from raw labels otherwise (same shared resolver, so the
 * two cannot drift). Null outside Linear mode — manual creation has no
 * Linear provenance.
 */
export function repoHintFor(
  sourceMode: "manual" | "linear",
  candidate: LinearCandidate | null
): LinearRepoResolution | null {
  if (sourceMode !== "linear" || !candidate) return null;
  return candidate.repoResolution ?? resolveLinearRepoLabels(candidate.labels);
}

/**
 * Next repository value when a Linear candidate is selected. Exactly one
 * valid label intentionally replaces the current value with its normalized
 * identity; every other outcome preserves the input untouched (including
 * empty — the operator then types or picks a recent repository).
 */
export function nextRepoForLinearCandidate(
  currentRepo: string,
  candidate: LinearCandidate | null
): string {
  if (!candidate) return currentRepo;
  const hint = candidate.repoResolution ?? resolveLinearRepoLabels(candidate.labels);
  if (hint.status === "resolved" && hint.repository) return hint.repository;
  return currentRepo;
}

/**
 * Compact inline warning for the repository control, or null when no warning
 * applies. Only conflicting or invalid `repo:` labels warn — the
 * resolved and no-label states render no extra UI.
 */
export function repoLabelWarning(
  sourceMode: "manual" | "linear",
  candidate: LinearCandidate | null
): string | null {
  const hint = repoHintFor(sourceMode, candidate);
  if (!hint) return null;
  if (hint.status === "conflict") {
    const labels = (hint.labels ?? []).join(", ");
    return `Conflicting repo: labels (${labels}) — kept the current repository. Fix the labels in Linear or type a repository below.`;
  }
  if (hint.status === "invalid") {
    const label = hint.labels?.[0] ?? "repo:";
    const reason = hint.error ? ` — ${hint.error}` : "";
    return `Invalid repository label ${label}${reason}. Kept the current repository — fix the label in Linear or type a repository below.`;
  }
  return null;
}

export interface NewIssueGate {
  title: string;
  repo: string;
  developerAgentId: string;
  reviewerAgentId: string;
}

/** Ordinary required-field validation: title, valid repo, developer, reviewer. */
export function canSubmitNewIssue(gate: NewIssueGate): boolean {
  return (
    gate.title.trim().length > 0 &&
    canonicalRepoIdentity(gate.repo) != null &&
    gate.developerAgentId.length > 0 &&
    gate.reviewerAgentId.length > 0
  );
}
