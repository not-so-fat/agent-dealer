// packages/server/src/coordinator/branch-tip-status.ts
//
// NOT-148: Issue Detail surfaces commits-ahead / "no tip yet" and restart risk next to
// live progress so operators can see cold-start retries before another hour burns.
import type { Issue } from "@agent-dealer/shared";
import {
  baseRefCandidates,
  developerBranchName,
  inspectBranchProgress,
  type BranchProgress,
} from "./branch-progress.js";

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

/**
 * Pure classifier used by the API once branch progress (and optional failure context) is known.
 * `hadFailedAttempt` is true when infraAttempts > 0 or a latest session failure is shown.
 */
export function classifyBranchTipStatus(opts: {
  branch: string;
  progress: BranchProgress | null;
  hadFailedAttempt: boolean;
}): BranchTipStatus {
  if (!opts.progress) {
    return {
      branch: opts.branch,
      state: "unknown",
      commitsAhead: null,
      tipLabel: "unknown",
      restartRisk: opts.hadFailedAttempt,
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
  };
}

/** Read-only tip status for Issue Detail while developing / retrying. */
export async function branchTipStatusForIssue(
  issue: Pick<Issue, "id" | "branch" | "repo" | "baseBranch" | "baseSha" | "infraAttempts" | "status">,
  opts?: { hadFailedAttempt?: boolean }
): Promise<BranchTipStatus | null> {
  // Surface during active develop/repair (and reviewing, so a just-handed-off tip stays visible).
  if (!["developing", "repairing", "reviewing"].includes(issue.status)) return null;

  const branch = developerBranchName(issue);
  const hadFailedAttempt = opts?.hadFailedAttempt ?? issue.infraAttempts > 0;

  let progress: BranchProgress | null = null;
  try {
    progress = await inspectBranchProgress({
      repo: issue.repo,
      branch,
      baseRefs: baseRefCandidates(issue),
    });
  } catch {
    progress = null;
  }

  return classifyBranchTipStatus({ branch, progress, hadFailedAttempt });
}
