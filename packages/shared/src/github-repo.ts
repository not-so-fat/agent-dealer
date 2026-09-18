import { z } from "zod";

/**
 * Canonical portable GitHub repository identity stored on issues (NOT-149).
 * Form: `github.com/<owner>/<repo>` (no scheme, no `.git`, no trailing slash).
 */
export const GitHubRepoIdentity = z
  .string()
  .regex(/^github\.com\/[^/]+\/[^/]+$/, "Expected github.com/<owner>/<repo>");
export type GitHubRepoIdentity = z.infer<typeof GitHubRepoIdentity>;

export interface ParsedGitHubRepo {
  owner: string;
  repo: string;
  /** Canonical identity: `github.com/owner/repo`. */
  identity: GitHubRepoIdentity;
  /** HTTPS clone URL without credentials. */
  cloneUrl: string;
}

const OWNER_REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/;

/**
 * True when the value looks like a local filesystem path (legacy issue.repo), not a
 * portable GitHub identity or URL. Used for explicit compatibility routing — never
 * silently guessed into a remote.
 */
export function looksLikeLocalRepoPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/") || trimmed.startsWith("~") || trimmed.startsWith(".")) return true;
  // Windows drive / UNC
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\")) return true;
  return false;
}

/**
 * Normalize a GitHub repository URL or `owner/repo` shorthand into a portable identity.
 * Rejects local filesystem paths — those need an explicit migration path, not guessing.
 */
export function parseGitHubRepoInput(raw: string): ParsedGitHubRepo {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Repository is required");
  }
  if (looksLikeLocalRepoPath(trimmed)) {
    throw new Error(
      "Local filesystem paths are no longer accepted. Pass a GitHub URL or owner/repo (e.g. https://github.com/acme/app or acme/app)."
    );
  }

  let owner: string;
  let repo: string;

  // owner/repo shorthand
  const short = OWNER_REPO.exec(trimmed);
  if (short && !trimmed.includes("://") && !trimmed.toLowerCase().includes("github.com")) {
    owner = short[1]!;
    repo = short[2]!;
  } else {
    // Strip credentials and normalize to a URL we can parse
    let urlText = trimmed;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(urlText)) {
      // github.com/owner/repo or git@github.com:owner/repo.git
      if (urlText.startsWith("git@")) {
        urlText = urlText.replace(/^git@([^:]+):/, "https://$1/");
      } else {
        urlText = `https://${urlText}`;
      }
    }
    let url: URL;
    try {
      url = new URL(urlText);
    } catch {
      throw new Error(`Unrecognized GitHub repository reference: ${raw}`);
    }
    if (!/^([^.]+\.)?github\.com$/i.test(url.hostname)) {
      throw new Error(`Only github.com repositories are supported (got host ${url.hostname})`);
    }
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      throw new Error(`Unrecognized GitHub repository reference: ${raw}`);
    }
    owner = parts[0];
    repo = parts[1].replace(/\.git$/i, "");
  }

  if (!owner || !repo || owner.includes("..") || repo.includes("..")) {
    throw new Error(`Unrecognized GitHub repository reference: ${raw}`);
  }

  const identity = GitHubRepoIdentity.parse(`github.com/${owner}/${repo}`);
  return {
    owner,
    repo,
    identity,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
  };
}

/** Zod transform for Create/UpdateIssueInput.repo — accepts URL or owner/repo. */
export const GitHubRepoInput = z
  .string()
  .min(1)
  .transform((value, ctx) => {
    try {
      return parseGitHubRepoInput(value).identity;
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (err as Error).message });
      return z.NEVER;
    }
  });
