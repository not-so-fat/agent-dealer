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

export async function pruneWorktrees(repo: string): Promise<void> {
  await git(repo, ["worktree", "prune"]);
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

/**
 * Create the checkout for one worker session. Developer = branch checkout the session
 * can commit/push; reviewer = detached HEAD at the exact SHA it must not mutate.
 * Serialized per repo.
 */
export async function createRoleWorktree(opts: {
  repo: string;
  role: WorkerSessionRole;
  sessionId: string;
  /** Branch name for a developer worktree, exact SHA for a reviewer worktree. */
  ref: string;
}): Promise<RoleWorktree> {
  const detached = opts.role === "reviewer";
  const worktreePath = roleWorktreePath(opts.sessionId, opts.role);
  await withRepoLock(opts.repo, async () => {
    await pruneWorktrees(opts.repo);
    await addWorktree({ repo: opts.repo, path: worktreePath, ref: opts.ref, detach: detached });
  });
  return { path: worktreePath, role: opts.role, ref: opts.ref, detached };
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
