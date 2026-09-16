// packages/server/src/coordinator/branch-progress.ts
//
// What an attempt already left on the issue branch (NOT-129).
//
// The unit of progress is the BRANCH, not the agent session. When a lease is lost, the
// commits the dead attempt made are still there — a commit that exists locally but was never
// pushed sat unpushed for three hours on NOT-121 while five fresh agent sessions re-ran a
// ~40-minute suite to redo it. Classifying the branch lets recovery route a reclaim to the
// existing no-agent republish path (`publishOnly` → developer-effect's runPublishOnlyHandoff)
// instead of paying for a whole new session.
//
// Every inspection is read-only and failure-tolerant: a missing repo, a missing base ref or
// any git error degrades to `absent`, which means "nothing known to publish" — i.e. exactly
// today's behaviour, a normal developer attempt. Wrongly republishing is the costly mistake
// here; wrongly re-running is only the status quo.
import {
  branchExists,
  countCommitsBetween,
  fetchRef,
  refExists,
} from "../adapters/git-worktree.js";

export type BranchProgress =
  /** No local branch (or git could not be consulted at all) — nothing to publish. */
  | { state: "absent"; branch: string }
  /** The branch exists but carries no commits past its base — nothing to publish. */
  | { state: "empty"; branch: string }
  /** Commits origin does not have: push + PR + checks, no agent. */
  | { state: "unpushed"; branch: string; ahead: number; unpushed: number }
  /** Already on origin: re-run PR identity + checks verification only, no agent. */
  | { state: "published"; branch: string; ahead: number };

/**
 * The branch a developer round works on. `issue.branch` is only written on a verified
 * clean_handoff (it is ground truth, not agent self-report), so an attempt that died before
 * that still left its commits on the conventional name — which is why the fallback here has
 * to match developer-effect.ts's.
 */
export function developerBranchName(issue: { id: string; branch: string | null }): string {
  return issue.branch ?? `issue-${issue.id}`;
}

/** Candidate base refs, most authoritative first — the first one that resolves is used. */
export function baseRefCandidates(issue: {
  baseSha: string | null;
  baseBranch: string;
}): string[] {
  return [issue.baseSha, `origin/${issue.baseBranch}`, issue.baseBranch].filter(
    (r): r is string => typeof r === "string" && r.length > 0
  );
}

/** A branch state that carries work — everything a republish needs is non-optional here. */
export type PublishableBranch = Extract<BranchProgress, { state: "unpushed" | "published" }>;

/** Whether this branch holds work that can be published without a new agent session. */
export function hasPublishableWork(progress: BranchProgress): progress is PublishableBranch {
  return progress.state === "unpushed" || progress.state === "published";
}

async function firstResolvableRef(repo: string, refs: string[]): Promise<string | null> {
  for (const ref of refs) {
    if (await refExists(repo, ref)) return ref;
  }
  return null;
}

/**
 * @param opts.fetch  update `origin/<branch>` before comparing. OFF for recovery: it runs on
 *                    every poll tick, and a network round-trip per expired lease would make
 *                    reclaim latency depend on GitHub. This is safe because the coordinator
 *                    is the only thing that pushes this branch, and `git push` updates the
 *                    remote-tracking ref as it goes — so the local view is already current
 *                    for every push the coordinator itself performed.
 */
export async function inspectBranchProgress(opts: {
  repo: string;
  branch: string;
  baseRefs: string[];
  fetch?: boolean;
}): Promise<BranchProgress> {
  const { repo, branch } = opts;
  try {
    if (!(await branchExists(repo, branch))) return { state: "absent", branch };

    // A base we cannot resolve is not evidence that the branch is empty — round 1 has no
    // base_sha yet, and a repo that never fetched has no origin/<base>. Trust the branch.
    const base = await firstResolvableRef(repo, opts.baseRefs);
    const ahead = base === null ? null : await countCommitsBetween({ repo, base, head: branch });
    if (ahead === 0) return { state: "empty", branch };

    if (opts.fetch) {
      // Fails when origin has no such branch yet — which is itself the `unpushed` answer.
      await fetchRef(repo, branch).catch(() => {});
    }

    const remote = `origin/${branch}`;
    if (!(await refExists(repo, remote))) {
      // Nothing to measure against: no base resolved AND origin has never seen this branch,
      // so "the branch carries work" is a guess. Guess the cheap way — a needless agent
      // session is the status quo, a push of an empty branch is a PR `gh` will reject.
      if (ahead === null) return { state: "absent", branch };
      return { state: "unpushed", branch, ahead, unpushed: ahead };
    }

    const unpushed = await countCommitsBetween({ repo, base: remote, head: branch });
    return unpushed > 0
      ? { state: "unpushed", branch, ahead: ahead ?? unpushed, unpushed }
      : { state: "published", branch, ahead: ahead ?? 0 };
  } catch {
    return { state: "absent", branch };
  }
}
