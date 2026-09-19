// packages/server/src/coordinator/branch-tip-status.ts
//
// NOT-148: Issue Detail surfaces commits-ahead / "no tip yet", restart risk, and
// dirty/preserved worktree hints next to live progress so operators can see cold-start
// retries (and salvage leftovers) before another hour burns.
import fs from "node:fs";
import type { Issue } from "@agent-dealer/shared";
import { classifyIssueRepo } from "../adapters/managed-repo.js";
import {
  findWorktreeForBranch,
  inspectLeftoverWorktree,
} from "../adapters/git-worktree.js";
import {
  baseRefCandidates,
  developerBranchName,
  inspectBranchProgress,
  type BranchProgress,
} from "./branch-progress.js";

export type BranchTipWorktreeHint = {
  /** Absolute path of the leftover / preserved checkout. */
  path: string;
  /** Uncommitted or unpushed work still on disk. */
  dirty: boolean;
  /** Coordinator preserved this checkout (unsafe remove / failed salvage). */
  preserved: boolean;
};

export type BranchTipStatus = {
  /** Issue branch name under inspection (conventional or recorded). */
  branch: string;
  /** Branch progress state, or `unknown` when git could not be consulted. */
  state: BranchProgress["state"] | "unknown";
  /** Commits ahead of base when known; null when absent/unknown. */
  commitsAhead: number | null;
  /** Operator-facing tip label: "no tip yet" | "N ahead" | "unknown". */
  tipLabel: string;
  /**
   * True when a prior infra failure left (or kept) an empty tip — the next developer
   * spawn would be a cold start on `base..branch`.
   */
  restartRisk: boolean;
  /**
   * Dirty / preserved developer checkout for this branch, when present and not the
   * currently running session's intentional WIP.
   */
  worktree: BranchTipWorktreeHint | null;
};

function tipLabelFor(progress: BranchProgress): { commitsAhead: number | null; tipLabel: string } {
  switch (progress.state) {
    case "absent":
    case "empty":
      return { commitsAhead: 0, tipLabel: "no tip yet" };
    case "unpushed":
    case "published":
      return {
        commitsAhead: progress.ahead,
        tipLabel: `${progress.ahead} ahead`,
      };
  }
}

function samePath(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return pathNorm(a) === pathNorm(b);
  }
}

function pathNorm(p: string): string {
  return p.replace(/\/+$/, "");
}

/**
 * Pure classifier used by the API once branch progress (and optional failure context) is known.
 * `hadFailedAttempt` is true when infraAttempts > 0 or a latest session failure is shown.
 */
export function classifyBranchTipStatus(opts: {
  branch: string;
  progress: BranchProgress | null;
  hadFailedAttempt: boolean;
  worktree?: BranchTipWorktreeHint | null;
}): BranchTipStatus {
  const worktree = opts.worktree ?? null;
  if (!opts.progress) {
    return {
      branch: opts.branch,
      state: "unknown",
      commitsAhead: null,
      tipLabel: "unknown",
      restartRisk: opts.hadFailedAttempt,
      worktree,
    };
  }
  const { commitsAhead, tipLabel } = tipLabelFor(opts.progress);
  // Empty tip = no publishable work on the branch. Do NOT treat `ahead === 0` on a
  // `published`/`unpushed` progress object as empty — `inspectBranchProgress` can report
  // `ahead ?? 0` when the base ref is unresolved while the branch is still publishable.
  const emptyTip = opts.progress.state === "absent" || opts.progress.state === "empty";
  return {
    branch: opts.branch,
    state: opts.progress.state,
    commitsAhead,
    tipLabel,
    restartRisk: emptyTip && opts.hadFailedAttempt,
    worktree,
  };
}

/** Resolve a local clone path for read-only tip inspection — never clones. */
function localRepoPathForTip(repoField: string): string | null {
  try {
    const classified = classifyIssueRepo(repoField);
    if (!fs.existsSync(classified.repoPath)) return null;
    return classified.repoPath;
  } catch {
    return null;
  }
}

/**
 * Dirty leftover on the issue branch that is not the live running session's checkout.
 * Mid-run WIP is normal; a leftover after failure/escalation is the salvage signal.
 */
async function preservedDirtyWorktreeHint(opts: {
  repoPath: string;
  branch: string;
  activeWorktreePath?: string | null;
}): Promise<BranchTipWorktreeHint | null> {
  const wtPath = await findWorktreeForBranch(opts.repoPath, opts.branch).catch(() => null);
  if (!wtPath) return null;
  if (opts.activeWorktreePath && samePath(opts.activeWorktreePath, wtPath)) {
    return null;
  }
  const leftover = await inspectLeftoverWorktree(wtPath);
  if (leftover !== "dirty_or_unpushed") return null;
  return { path: wtPath, dirty: true, preserved: true };
}

/** Read-only tip status for Issue Detail while developing / retrying. */
export async function branchTipStatusForIssue(
  issue: Pick<Issue, "id" | "branch" | "repo" | "baseBranch" | "baseSha" | "infraAttempts" | "status">,
  opts?: {
    hadFailedAttempt?: boolean;
    /** Running session worktree — dirty there is live WIP, not a preserve signal. */
    activeWorktreePath?: string | null;
  }
): Promise<BranchTipStatus | null> {
  // Surface during active develop/repair (and reviewing, so a just-handed-off tip stays visible).
  if (!["developing", "repairing", "reviewing"].includes(issue.status)) return null;

  const branch = developerBranchName(issue);
  const hadFailedAttempt = opts?.hadFailedAttempt ?? issue.infraAttempts > 0;

  const repoPath = localRepoPathForTip(issue.repo);
  let progress: BranchProgress | null = null;
  let worktree: BranchTipWorktreeHint | null = null;

  if (repoPath) {
    try {
      progress = await inspectBranchProgress({
        repo: repoPath,
        branch,
        baseRefs: baseRefCandidates(issue),
      });
    } catch {
      progress = null;
    }
    worktree = await preservedDirtyWorktreeHint({
      repoPath,
      branch,
      activeWorktreePath: opts?.activeWorktreePath,
    });
  }

  return classifyBranchTipStatus({ branch, progress, hadFailedAttempt, worktree });
}
