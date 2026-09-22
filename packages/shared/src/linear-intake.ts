import { z } from "zod";
import { parseGitHubRepoInput } from "./github-repo.js";

/**
 * NOT-242: explicit Linear repository labels.
 *
 * A Linear issue declares its GitHub repository with a reusable label that
 * carries the canonical identity directly, e.g.
 * `repo:github.com/not-so-fat/agent-dealer`. Dealer never infers a repository
 * from ordinary product labels, ticket text, team, title, or recent history —
 * only an explicit `repo:` label resolves.
 */

/** Label prefix (matched case-insensitively); the remainder is a GitHub identity. */
export const REPO_LABEL_PREFIX = "repo:";

export const LinearRepoResolutionStatus = z.enum([
  "resolved",
  "unresolved",
  "conflict",
  "invalid",
]);
export type LinearRepoResolutionStatus = z.infer<typeof LinearRepoResolutionStatus>;

/**
 * Server-resolved repository hint attached to a Linear candidate. Raw labels
 * stay on the candidate; this is the deterministic read of the `repo:` ones.
 */
export const LinearRepoResolution = z.object({
  status: LinearRepoResolutionStatus,
  /** Canonical `github.com/<owner>/<repo>` — present only when resolved. */
  repository: z.string().optional(),
  /** Exact raw label the repository came from — present only when resolved. */
  sourceLabel: z.string().optional(),
  /** Every matching `repo:` label (conflict shows all of them; invalid the one). */
  labels: z.array(z.string()).optional(),
  /** Why a single `repo:` label could not be used — present only when invalid. */
  error: z.string().optional(),
});
export type LinearRepoResolution = z.infer<typeof LinearRepoResolution>;

/** Raw labels that claim to name a repository — prefix match is case-insensitive. */
export function extractRepoLabels(labels: readonly string[] | undefined): string[] {
  if (!labels) return [];
  return labels.filter((l) => l.toLowerCase().startsWith(REPO_LABEL_PREFIX));
}

/**
 * Deterministic resolution over a candidate's raw labels. Repository parsing
 * reuses the shared `parseGitHubRepoInput` contract, so a label-derived
 * identity and a manually entered one cannot drift.
 */
export function resolveLinearRepoLabels(labels: readonly string[] | undefined): LinearRepoResolution {
  const matches = extractRepoLabels(labels);
  if (matches.length === 0) {
    return { status: "unresolved", labels: [] };
  }
  if (matches.length > 1) {
    // Never pick first — the operator resolves the conflict in Linear.
    return { status: "conflict", labels: [...matches] };
  }
  const raw = matches[0]!;
  const value = raw.slice(REPO_LABEL_PREFIX.length).trim();
  if (!value) {
    return { status: "invalid", labels: [raw], error: "Repository label has no value" };
  }
  try {
    const parsed = parseGitHubRepoInput(value);
    return { status: "resolved", repository: parsed.identity, sourceLabel: raw, labels: [raw] };
  } catch (err) {
    return { status: "invalid", labels: [raw], error: (err as Error).message };
  }
}
