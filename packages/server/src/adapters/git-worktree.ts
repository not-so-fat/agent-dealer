// packages/server/src/adapters/git-worktree.ts
//
// One worktree manager for the coordinator: developer sessions get a read-write
// checkout on the issue branch, reviewer sessions get a separate detached-HEAD
// checkout pinned to the verified head SHA (design §"Worktree lifecycle and
// concurrency"). Every add/remove/prune for one repo is serialized behind
// withRepoLock so two sessions on the same repo never race `.git` metadata.
//
// Lifted from archive/not-57-full-p0-slice and extended with role-aware creation,
// safe (non-destructive) removal, and leftover inspection for crash recovery.
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkerSessionRole } from "@agent-dealer/shared";
import { getDataDir } from "../db/index.js";
import { withRepoLock } from "../runners/process-registry.js";

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await run("git", args, { cwd });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(`git ${args.join(" ")} failed: ${e.stderr?.trim() || e.message}`);
  }
}

export async function addWorktree(opts: {
  repo: string;
  path: string;
  ref: string;
  detach?: boolean;
  newBranch?: string;
}): Promise<void> {
  const args = ["worktree", "add"];
  if (opts.detach) args.push("--detach");
  if (opts.newBranch) args.push("-b", opts.newBranch);
  args.push(opts.path, opts.ref);
  await git(opts.repo, args);
}

export async function removeWorktree(opts: { repo: string; path: string; force?: boolean }): Promise<void> {
  const args = ["worktree", "remove"];
  if (opts.force) args.push("--force");
  args.push(opts.path);
  await git(opts.repo, args);
}

export async function isWorktreeClean(worktreePath: string): Promise<boolean> {
  const { stdout } = await git(worktreePath, ["status", "--porcelain"]);
  return stdout.trim().length === 0;
}

export async function mergeBase(opts: { repo: string; base: string; head: string }): Promise<string> {
  const { stdout } = await git(opts.repo, ["merge-base", opts.base, opts.head]);
  return stdout.trim();
}

/** Updates the local `origin/<ref>` remote-tracking branch — call before resolving a base SHA against it. */
export async function fetchRef(worktreePath: string, ref: string): Promise<void> {
  await git(worktreePath, ["fetch", "origin", ref]);
}

/** The worktree's actual local HEAD — compared against what `gh` reports to catch a stale/wrong view. */
export async function revParseHead(worktreePath: string): Promise<string> {
  const { stdout } = await git(worktreePath, ["rev-parse", "HEAD"]);
  return stdout.trim();
}

export async function pruneWorktrees(repo: string): Promise<void> {
  await git(repo, ["worktree", "prune"]);
}

/** Whether a local branch already exists — a retry must reuse it, never re-create with -b. */
export async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export { withRepoLock };

/** Where role worktrees are checked out — a sibling of the sqlite db, off the repo tree. */
export function worktreesRoot(): string {
  return path.join(getDataDir(), "worktrees");
}

export function roleWorktreePath(sessionId: string, role: WorkerSessionRole): string {
  return path.join(worktreesRoot(), `${sessionId}-${role}`);
}

export interface RoleWorktree {
  path: string;
  role: WorkerSessionRole;
  ref: string;
  detached: boolean;
}

/** RFC 2606 reserved TLD — guaranteed never to resolve. */
const BLOCKED_PUSH_URL = "https://push-blocked.invalid/policy-denied.git";

/**
 * Redirects `remote.origin.pushurl` for one worktree, scoped to that worktree only
 * (requires `extensions.worktreeConfig`). This is HYGIENE, not a security boundary: a
 * review round proved it bypassable by the very process it would restrict — `git push
 * <remote-url>` skips the named remote entirely, and a worker with ordinary write access
 * to its own worktree can simply `git config --worktree --unset-all
 * remote.origin.pushurl` before pushing. Applied unconditionally to reviewer worktrees
 * (which have no write/Bash grant to begin with — see `args.ts` — so this never needs to
 * hold on its own) to make an accidental `git push` from a read-only session fail
 * immediately instead of silently succeeding. There is no `push`-capability parameter
 * here: see `profile-snapshot.ts`'s `PermissionPolicy` doc comment for why `push` is not
 * modeled as a profile-tunable capability at all.
 */
async function blockPush(repo: string, worktreePath: string): Promise<void> {
  await git(repo, ["config", "extensions.worktreeConfig", "true"]);
  await git(worktreePath, ["config", "--worktree", "remote.origin.pushurl", BLOCKED_PUSH_URL]);
}

/**
 * Create the checkout for one worker session. Developer = branch checkout the session
 * can commit/push; reviewer = detached HEAD at the exact SHA it must not mutate (and is
 * additionally push-blocked as hygiene — see `blockPush`). Serialized per repo.
 *
 * `newBranch` creates a fresh branch off `ref` (round 1 of a developer session, where the
 * issue has no branch yet) instead of checking out an existing one (repair rounds 2+).
 */
export async function createRoleWorktree(opts: {
  repo: string;
  role: WorkerSessionRole;
  sessionId: string;
  /** Existing branch name or exact SHA to check out, or the base ref when `newBranch` is set. */
  ref: string;
  /** Developer round 1 only: create this branch off `ref` instead of checking it out. */
  newBranch?: string;
}): Promise<RoleWorktree> {
  const detached = opts.role === "reviewer";
  const worktreePath = roleWorktreePath(opts.sessionId, opts.role);
  await withRepoLock(opts.repo, async () => {
    await pruneWorktrees(opts.repo);
    await addWorktree({
      repo: opts.repo,
      path: worktreePath,
      ref: opts.ref,
      detach: detached,
      newBranch: opts.newBranch,
    });
    if (detached) await blockPush(opts.repo, worktreePath);
  });
  return { path: worktreePath, role: opts.role, ref: opts.newBranch ?? opts.ref, detached };
}

export type PushResult = { ok: true } | { ok: false; reason: string; rejected: boolean };

const PUSH_REJECTION_PATTERNS = /rejected|non-fast-forward|fetch first|stale info/i;

/**
 * The coordinator — never the developer worker — pushes the branch, after the worker's
 * session has already ended (design §"Role permissions": the credentialed push effect
 * never runs inside the worker's own process; see profile-snapshot.ts's PermissionPolicy
 * doc comment for why this could never be an enforceable worker-side policy toggle).
 * Distinguishes a clean rejection (remote diverged — `unpushed_commit`, a policy_escalation
 * a human resolves) from an unexpected tooling failure (`adapter_failure`).
 */
export async function pushBranch(opts: { worktreePath: string; branch: string }): Promise<PushResult> {
  try {
    await git(opts.worktreePath, ["push", "-u", "origin", `HEAD:refs/heads/${opts.branch}`]);
    return { ok: true };
  } catch (err) {
    const message = (err as Error).message;
    return { ok: false, reason: message, rejected: PUSH_REJECTION_PATTERNS.test(message) };
  }
}

/** Commits on HEAD not on `baseRef` — zero means the developer produced nothing to push/PR. */
export async function commitsAhead(opts: { worktreePath: string; baseRef: string }): Promise<number> {
  const { stdout } = await git(opts.worktreePath, ["rev-list", "--count", `${opts.baseRef}..HEAD`]);
  return Number(stdout.trim());
}

export type WorktreeRemoval =
  | { removed: true }
  | { removed: false; preserved: true; path: string; reason: string; recoveryCommands: string[] };

/**
 * Remove a worktree only when it is safe to. A reviewer checkout can always go once
 * its evidence is stored; a developer checkout is removed only when it is clean AND its
 * branch is pushed. Anything else is preserved and handed back so the caller can raise
 * a policy_escalation — the coordinator never force-removes potentially valuable work
 * (design §"Worktree lifecycle and concurrency").
 */
export async function safeRemoveWorktree(opts: {
  repo: string;
  path: string;
  role: WorkerSessionRole;
  /** Developer only: whether the issue branch has been pushed to the remote. */
  branchPushed?: boolean;
}): Promise<WorktreeRemoval> {
  const clean = await isWorktreeClean(opts.path).catch(() => false);
  const safe = clean && (opts.role === "reviewer" || opts.branchPushed === true);
  if (!safe) {
    return {
      removed: false,
      preserved: true,
      path: opts.path,
      reason: !clean ? "worktree has uncommitted changes" : "issue branch is not pushed",
      recoveryCommands: [
        `cd ${opts.path}`,
        "git status",
        "git stash list",
        `git -C ${opts.repo} worktree remove ${opts.path}  # only after the work is saved`,
      ],
    };
  }
  await withRepoLock(opts.repo, async () => {
    await removeWorktree({ repo: opts.repo, path: opts.path });
    await pruneWorktrees(opts.repo);
  });
  return { removed: true };
}

export type LeftoverState = "missing" | "clean" | "dirty_or_unpushed";

/** Classify a worktree left behind by a crash so recovery can decide what to do. */
export async function inspectLeftoverWorktree(worktreePath: string): Promise<LeftoverState> {
  try {
    const clean = await isWorktreeClean(worktreePath);
    return clean ? "clean" : "dirty_or_unpushed";
  } catch {
    return "missing";
  }
}
