import { z } from "zod";
import { parseGitHubRepoInput } from "./github-repo.js";

/**
 * NOT-361: normalize a Linear picker patch before persistence.
 * Trims status names, drops empties, coerces blank teamId to null.
 * Throws a readable Error when the resulting status list would be empty.
 */
export function normalizeLinearIntakePickerPatch(input: {
  stateFilter?: string[] | undefined;
  teamId?: string | null | undefined;
  assigneeMe?: boolean | undefined;
}): {
  stateFilter?: string[];
  teamId?: string | null;
  assigneeMe?: boolean;
} {
  const out: {
    stateFilter?: string[];
    teamId?: string | null;
    assigneeMe?: boolean;
  } = {};
  if (input.stateFilter !== undefined) {
    const stateFilter = input.stateFilter.map((s) => s.trim()).filter(Boolean);
    if (stateFilter.length === 0) {
      throw new Error("Select at least one workflow status");
    }
    out.stateFilter = stateFilter;
  }
  if (input.teamId !== undefined) {
    const trimmed = typeof input.teamId === "string" ? input.teamId.trim() : "";
    out.teamId = trimmed.length > 0 ? trimmed : null;
  }
  if (input.assigneeMe !== undefined) {
    out.assigneeMe = Boolean(input.assigneeMe);
  }
  return out;
}

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
 * NOT-260: configurable Linear label → repository mappings.
 *
 * A normalized Linear label (trimmed, 1–100 chars) is a unique key pointing
 * at exactly one normalized `github.com/<owner>/<repo>` identity. Different
 * labels may point at the same repository.
 */
export const MAX_REPOSITORY_MAPPINGS = 100;

export const LinearRepositoryMapping = z.object({
  /** Normalized on write: trimmed, 1–100 characters. */
  label: z.string(),
  /** Normalized on write with `parseGitHubRepoInput` to `github.com/<owner>/<repo>`. */
  repository: z.string(),
});
export type LinearRepositoryMapping = z.infer<typeof LinearRepositoryMapping>;

export const LinearRepositoryMappingsInput = z.object({
  mappings: z.array(LinearRepositoryMapping).max(MAX_REPOSITORY_MAPPINGS + 1),
});
export type LinearRepositoryMappingsInput = z.infer<typeof LinearRepositoryMappingsInput>;

/** Trim + lowercase identity used for duplicate detection and matching. */
export function normalizeMappingLabel(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * Validate and normalize a raw mappings payload. Returns normalized
 * `{ label, repository }` rows (label trimmed, repository canonicalized).
 * Throws a readable Error on empty labels, overlong labels, invalid
 * repositories, duplicate normalized labels, or more than 100 rows —
 * callers persist only on success so failures stay atomic.
 */
export function normalizeRepositoryMappings(
  input: { mappings: Array<{ label: string; repository: string }> },
): LinearRepositoryMapping[] {
  const rows = input.mappings ?? [];
  if (rows.length > MAX_REPOSITORY_MAPPINGS) {
    throw new Error(`At most ${MAX_REPOSITORY_MAPPINGS} repository mappings are allowed`);
  }
  const seen = new Set<string>();
  const out: LinearRepositoryMapping[] = [];
  for (const row of rows) {
    const label = (row.label ?? "").trim();
    if (!label) throw new Error("Mapping label must not be empty");
    if (label.length > 100) throw new Error(`Mapping label must be 1–100 characters (got "${label}")`);
    const key = label.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate repository mapping for label "${label}"`);
    seen.add(key);
    let repository: string;
    try {
      repository = parseGitHubRepoInput(row.repository ?? "").identity;
    } catch (err) {
      throw new Error(`Invalid repository for label "${label}": ${(err as Error).message}`);
    }
    out.push({ label, repository });
  }
  return out;
}

/**
 * NOT-260 mapped resolution over a candidate's raw labels:
 * 1. Match configured mappings by trimmed, case-insensitive label equality.
 * 2. No match: fall back to the existing `repo:` resolver.
 * 3. One distinct mapped repository: `resolved` with the matched Linear label
 *    as `sourceLabel`.
 * 4. Multiple matched labels targeting different repositories: `conflict`.
 * 5. Multiple matched labels targeting the same repository resolve.
 */
export function resolveLinearRepoWithMappings(
  labels: readonly string[] | undefined,
  mappings: readonly LinearRepositoryMapping[] | undefined,
): LinearRepoResolution {
  const saved = mappings ?? [];
  if (saved.length > 0 && labels && labels.length > 0) {
    const byKey = new Map<string, string>();
    for (const m of saved) byKey.set(normalizeMappingLabel(m.label), m.repository);
    const matchedRepos: string[] = [];
    const matchedLabels: string[] = [];
    for (const raw of labels) {
      const repo = byKey.get(raw.trim().toLowerCase());
      if (repo !== undefined) {
        matchedRepos.push(repo);
        matchedLabels.push(raw);
      }
    }
    if (matchedLabels.length > 0) {
      const distinct = [...new Set(matchedRepos)];
      if (distinct.length === 1) {
        return { status: "resolved", repository: distinct[0], sourceLabel: matchedLabels[0], labels: matchedLabels };
      }
      return { status: "conflict", labels: matchedLabels };
    }
  }
  return resolveLinearRepoLabels(labels);
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

/**
 * NOT-364: a Linear issue attachment as returned by the direct GraphQL query.
 * `subtitle` and `source` are Linear's own optional metadata (present on link
 * attachments that point at external documents, often absent on uploaded
 * files). Files that exist only inside Linear *comments* never appear here —
 * the query reads the issue's own `attachments` connection only.
 */
export const LinearAttachment = z.object({
  /** Stable Linear attachment id — the reconciliation key across reloads. */
  id: z.string(),
  /** Display name (`repro.tar.gz`) or link title. */
  title: z.string(),
  /** Download URL for hosted files (short-lived) or the external target for links. */
  url: z.string(),
  subtitle: z.string().optional(),
  /** Linear's source metadata, coerced to a string by the adapter when needed. */
  source: z.string().optional(),
});
export type LinearAttachment = z.infer<typeof LinearAttachment>;

/**
 * NOT-364: Linear-hosted file uploads live under Linear's own upload hosts;
 * everything else is an ordinary external link. Hosted files are snapshotted
 * into Dealer-owned storage at import/reload so a queued Builder never needs
 * the (expiring) Linear URL; links are metadata only and never downloaded.
 */
export function isLinearHostedAttachmentUrl(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "uploads.linear.app" || host.endsWith(".uploads.linear.app") || host === "linear.app" || host.endsWith(".linear.app");
}

/**
 * NOT-364: a durable Dealer-side record of one Linear issue attachment.
 * `kind: "file"` rows carry a Dealer-owned `blobPath` plus integrity fields;
 * `kind: "link"` rows carry source metadata only and must never be presented
 * as offline-available files.
 */
export const SourceAttachmentRecord = z.object({
  linearAttachmentId: z.string(),
  kind: z.enum(["file", "link"]),
  title: z.string(),
  /** Worktree-local safe basename for files — absent on links. */
  safeFileName: z.string().optional(),
  /** Dealer-owned blob path for downloaded files — absent on links. */
  blobPath: z.string().optional(),
  contentType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  sha256: z.string().optional(),
  /** The Linear (possibly expiring) URL for files, the external target for links. */
  url: z.string(),
  subtitle: z.string().optional(),
  source: z.string().optional(),
});
export type SourceAttachmentRecord = z.infer<typeof SourceAttachmentRecord>;
