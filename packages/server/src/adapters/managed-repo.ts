// packages/server/src/adapters/managed-repo.ts
//
// NOT-149: Dealer owns local clones and session worktrees. Issues store a portable
// GitHub identity (`github.com/owner/repo`); this module resolves that into a
// deterministic checkout under executionRoot. Legacy issue.repo values that are still
// local filesystem paths are recoverable only when the path still exists — never by
// guessing a remote from a missing origin.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkerSessionRole } from "@agent-dealer/shared";
import {
  looksLikeLocalRepoPath,
  parseGitHubRepoInput,
  type GitHubRepoIdentity,
  type ParsedGitHubRepo,
} from "@agent-dealer/shared";
import { getExecutionRoot } from "../paths.js";
import { withRepoLock } from "../runners/process-registry.js";

const run = promisify(execFile);

async function git(cwd: string | undefined, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await run("git", args, { ...(cwd ? { cwd } : {}), encoding: "utf8" });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(`git ${args.join(" ")} failed: ${e.stderr?.trim() || e.message}`);
  }
}

export function managedRepoPath(identity: GitHubRepoIdentity): string {
  return path.join(getExecutionRoot(), "repos", identity);
}

export function managedWorktreePath(
  identity: GitHubRepoIdentity,
  sessionId: string,
  role: WorkerSessionRole
): string {
  return path.join(getExecutionRoot(), "worktrees", identity, `${sessionId}-${role}`);
}

export function managedWorktreesRoot(identity: GitHubRepoIdentity): string {
  return path.join(getExecutionRoot(), "worktrees", identity);
}

export type IssueRepoResolution =
  | {
      kind: "managed";
      identity: GitHubRepoIdentity;
      parsed: ParsedGitHubRepo;
      /** Local bare-ish clone / cache used as the worktree add parent. */
      repoPath: string;
    }
  | {
      kind: "legacy_local";
      /** Explicit compatibility: recorded local path still present on disk. */
      repoPath: string;
      identity: null;
    };

/**
 * Classify an issue.repo value without cloning. Throws when a legacy local path is
 * gone or when a non-local value is not a valid GitHub identity.
 */
export function classifyIssueRepo(repoField: string): IssueRepoResolution {
  const trimmed = repoField.trim();
  if (looksLikeLocalRepoPath(trimmed)) {
    if (!fs.existsSync(trimmed)) {
      throw new Error(
        `Legacy issue repo path is missing (${trimmed}). Re-create the issue with a GitHub URL, or restore the checkout — Dealer will not guess a remote.`
      );
    }
    return { kind: "legacy_local", repoPath: trimmed, identity: null };
  }
  const parsed = parseGitHubRepoInput(trimmed);
  return {
    kind: "managed",
    identity: parsed.identity,
    parsed,
    repoPath: managedRepoPath(parsed.identity),
  };
}

/**
 * Ensure a managed clone exists and is fetched; return the local path to use as the
 * git worktree parent. For legacy local-path issues, returns the existing path as-is.
 *
 * When `cloneUrlOverride` is set (tests), clones from that URL/path instead of GitHub.
 */
export async function ensureIssueRepoCheckout(
  repoField: string,
  opts?: { cloneUrlOverride?: string; fetchDefaultBranch?: boolean }
): Promise<IssueRepoResolution & { defaultBranch?: string }> {
  const classified = classifyIssueRepo(repoField);
  if (classified.kind === "legacy_local") {
    return classified;
  }

  const dest = classified.repoPath;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const cloneUrl = opts?.cloneUrlOverride ?? classified.parsed.cloneUrl;

  // Serialize clone/fetch against the shared managed clone — same lock createRoleWorktree
  // uses — so two issues on one GitHub repo cannot race the first clone or prune fetch.
  return withRepoLock(dest, async () => {
    if (!fs.existsSync(path.join(dest, ".git")) && !fs.existsSync(path.join(dest, "HEAD"))) {
      // Prefer a regular clone (not bare) so existing worktree helpers that expect a
      // working tree + .git directory keep working; worktrees still hang off this repo.
      await git(undefined, ["clone", "--filter=blob:none", cloneUrl, dest]);
    } else {
      // Refresh remotes; ignore failure when offline — local objects may still suffice.
      try {
        await git(dest, ["fetch", "--prune", "origin"]);
      } catch {
        /* keep cached clone */
      }
    }

    let defaultBranch: string | undefined;
    if (opts?.fetchDefaultBranch !== false) {
      defaultBranch = await resolveRemoteDefaultBranch(dest);
    }
    return { ...classified, defaultBranch };
  });
}

/** Read origin/HEAD or fall back to main/master. */
export async function resolveRemoteDefaultBranch(repoPath: string): Promise<string> {
  try {
    const { stdout } = await git(repoPath, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    const m = stdout.trim().match(/refs\/remotes\/origin\/(.+)$/);
    if (m?.[1]) return m[1];
  } catch {
    /* fall through */
  }
  for (const candidate of ["main", "master"]) {
    try {
      await git(repoPath, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
      return candidate;
    } catch {
      /* try next */
    }
  }
  try {
    const { stdout } = await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = stdout.trim();
    if (branch && branch !== "HEAD") return branch;
  } catch {
    /* fall through */
  }
  return "main";
}

/**
 * Try to derive a portable GitHub identity from a legacy local checkout's `origin`.
 * Returns null when origin is missing or not GitHub — callers must surface that to the
 * operator instead of inventing a remote.
 */
export async function tryResolveOriginGitHubIdentity(
  localRepoPath: string
): Promise<GitHubRepoIdentity | null> {
  try {
    const { stdout } = await git(localRepoPath, ["remote", "get-url", "origin"]);
    const url = stdout.trim();
    if (!url) return null;
    return parseGitHubRepoInput(url).identity;
  } catch {
    return null;
  }
}

/**
 * Where role worktrees live for a resolved issue checkout (managed or legacy).
 * Managed: `<executionRoot>/worktrees/github.com/<owner>/<repo>`
 * Legacy: `<repo>/.agent-dealer-worktrees` (pre-NOT-149 layout, still recoverable).
 */
export function worktreesRootForResolution(resolution: IssueRepoResolution): string {
  if (resolution.kind === "managed") {
    return managedWorktreesRoot(resolution.identity);
  }
  return path.join(resolution.repoPath, ".agent-dealer-worktrees");
}

export function roleWorktreePathForResolution(
  resolution: IssueRepoResolution,
  sessionId: string,
  role: WorkerSessionRole
): string {
  if (resolution.kind === "managed") {
    return managedWorktreePath(resolution.identity, sessionId, role);
  }
  return path.join(worktreesRootForResolution(resolution), `${sessionId}-${role}`);
}

/**
 * Single base-branch rule for worktree cut, PR create/identity, and review merge-base (NOT-149).
 * Managed checkouts use the freshly fetched remote default; legacy local paths keep
 * `issue.baseBranch`. Call sites must not invent a second rule.
 */
export function resolveCheckoutBaseBranch(
  issueBaseBranch: string,
  checkout: { kind: "managed" | "legacy_local"; defaultBranch?: string }
): string {
  if (checkout.kind === "managed" && checkout.defaultBranch) {
    return checkout.defaultBranch;
  }
  return issueBaseBranch;
}
