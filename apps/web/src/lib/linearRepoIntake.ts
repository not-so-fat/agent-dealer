import type { LinearCandidate, LinearRepoResolution } from "@agent-dealer/shared";
import { parseGitHubRepoInput, resolveLinearRepoLabels } from "@agent-dealer/shared";

/**
 * NOT-242: repository confirmation view-model for the New issue form.
 *
 * The operator must explicitly confirm the exact canonical repository after
 * the last ticket / repository / source-mode change — otherwise Kick/Create
 * stays disabled. A stale confirmation can never submit a different
 * repository because confirmation is only valid while it equals the current
 * canonical identity.
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
 * Linear provenance but keeps the same confirmation rule.
 */
export function repoHintFor(
  sourceMode: "manual" | "linear",
  candidate: LinearCandidate | null
): LinearRepoResolution | null {
  if (sourceMode !== "linear" || !candidate) return null;
  return candidate.repoResolution ?? resolveLinearRepoLabels(candidate.labels);
}

/** True only while the confirmed identity is exactly the current canonical one. */
export function isRepoConfirmed(repo: string, confirmedRepo: string | null): boolean {
  const canonical = canonicalRepoIdentity(repo);
  return canonical != null && confirmedRepo === canonical;
}

export interface NewIssueGate {
  title: string;
  repo: string;
  developerAgentId: string;
  reviewerAgentId: string;
  confirmedRepo: string | null;
}

/** Submit stays disabled until every field is present AND the exact repo is confirmed. */
export function canSubmitNewIssue(gate: NewIssueGate): boolean {
  return (
    gate.title.trim().length > 0 &&
    gate.developerAgentId.length > 0 &&
    gate.reviewerAgentId.length > 0 &&
    isRepoConfirmed(gate.repo, gate.confirmedRepo)
  );
}
