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
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkerSessionRole } from "@agent-dealer/shared";
import { withRepoLock } from "../runners/process-registry.js";

/** Directory name under the issue repo for coordinator-managed role worktrees.
 * Kept inside the repo (not `$AGENT_DEALER_HOME`) so `agent-deck use` grants cover the
 * worker cwd and `bind_workspace` to that path can succeed. */
export const WORKTREES_DIR_NAME = ".agent-dealer-worktrees";

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await run("git", args, { cwd });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(`git ${args.join(" ")} failed: ${e.stderr?.trim() || e.message}`);
  }
}

/** Default bound for the pre-branch fetch of `origin/<baseBranch>` (NOT-197). */
export const DEFAULT_BASE_FETCH_TIMEOUT_MS = 60_000;

export type FreshBaseFetch =
  /** `ref` is the worktree-add ref a fresh branch must be cut from; `sha` is its tip. */
  | { ok: true; sha: string; ref: string }
  | { ok: false; reason: string };

function clampFetchTimeoutMs(timeoutMs: number | undefined): number {
  return Number.isFinite(timeoutMs) && (timeoutMs as number) > 0
    ? (timeoutMs as number)
    : DEFAULT_BASE_FETCH_TIMEOUT_MS;
}

/** Whether `repo` has an `origin` remote at all. */
async function hasOriginRemote(repo: string): Promise<boolean> {
  try {
    await git(repo, ["remote", "get-url", "origin"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * NOT-197: resolve the commit a fresh developer branch must start from. Fetches
 * `origin/<baseBranch>` in the cached clone with a bounded timeout and returns the
 * fetched `origin/<baseBranch>` tip — never the possibly-stale local base branch the
 * cached clone was left on.
 *
 * A repo with no `origin` remote has no fresher truth than its local branches, so the
 * local base is used as-is (legacy local checkouts keep working offline). Any other
 * fetch failure — network down, VPN, timeout — is returned, never silently replaced
 * with the stale local branch: the caller defers the start instead.
 */
export async function fetchFreshBase(
  repo: string,
  baseBranch: string,
  timeoutMs?: number
): Promise<FreshBaseFetch> {
  const boundMs = clampFetchTimeoutMs(timeoutMs);
  if (!(await hasOriginRemote(repo))) {
    try {
      const { stdout } = await git(repo, ["rev-parse", baseBranch]);
      return { ok: true, sha: stdout.trim(), ref: baseBranch };
    } catch (err) {
      return { ok: false, reason: `no origin remote and local base ${baseBranch} does not resolve: ${(err as Error).message}` };
    }
  }
  try {
    await run("git", ["fetch", "origin", baseBranch], { cwd: repo, timeout: boundMs });
  } catch (err) {
    const e = err as { message?: string; stderr?: string; killed?: boolean };
    const timedOut = e?.killed === true;
    const detail = typeof e?.stderr === "string" && e.stderr.trim() ? e.stderr.trim() : e?.message;
    return {
      ok: false,
      reason: timedOut
        ? `git fetch origin ${baseBranch} timed out after ${boundMs}ms — network or VPN may be down`
        : `git fetch origin ${baseBranch} failed: ${detail}`,
    };
  }
  try {
    const { stdout } = await git(repo, ["rev-parse", `origin/${baseBranch}`]);
    return { ok: true, sha: stdout.trim(), ref: `origin/${baseBranch}` };
  } catch (err) {
    return { ok: false, reason: `fetched origin ${baseBranch} but origin/${baseBranch} does not resolve: ${(err as Error).message}` };
  }
}

/**
 * NOT-219: what a `git fetch origin <branch>` on the reuse path found.
 * `remoteSha` is the fetched `origin/<branch>` tip, or null when the remote has no
 * such branch yet (or the repo has no origin at all) — in both cases there is nothing
 * to catch up to and the local branch is used as-is.
 */
export type ReusedBranchFetch =
  | { ok: true; remoteSha: string | null }
  | { ok: false; reason: string };

/** `git fetch origin <branch>` output when the remote simply has no such branch. */
const NO_REMOTE_REF_PATTERNS = /couldn't find remote ref|remote ref .* does not exist/i;

function fetchErrorDetail(err: unknown): string {
  const e = err as { message?: string; stderr?: string; killed?: boolean };
  return typeof e?.stderr === "string" && e.stderr.trim() ? e.stderr.trim() : (e?.message ?? String(err));
}

/**
 * NOT-219: fetch `origin/<branch>` before reusing an existing issue branch for a
 * repair round, so the worktree starts at exactly what Dealer pushed (and the
 * reviewer reviewed) — never the managed clone's possibly-stale local ref. The
 * stale-local case is real: a round-1 worker that commits on a side branch leaves
 * the local issue branch at its creation point while Dealer pushes HEAD to
 * `origin/<branch>`, and reusing the local ref then cherry-picks/push-rejects.
 *
 * A fetch that fails (network down, timeout) is returned — never silently replaced
 * with the stale local branch: the caller defers the start like NOT-197's
 * `base_unavailable`. The one fetch failure that is NOT a deferral is a remote with
 * no such branch yet (a same-round retry whose branch was never pushed): there is
 * nothing to catch up to, so the local branch is used as-is.
 */
export async function fetchReusedBranch(
  repo: string,
  branch: string,
  timeoutMs?: number
): Promise<ReusedBranchFetch> {
  const boundMs = clampFetchTimeoutMs(timeoutMs);
  if (!(await hasOriginRemote(repo))) {
    return { ok: true, remoteSha: null };
  }
  try {
    await run("git", ["fetch", "origin", branch], { cwd: repo, timeout: boundMs });
  } catch (err) {
    const e = err as { killed?: boolean };
    const detail = fetchErrorDetail(err);
    if (NO_REMOTE_REF_PATTERNS.test(detail)) {
      return { ok: true, remoteSha: null };
    }
    const timedOut = e?.killed === true;
    return {
      ok: false,
      reason: timedOut
        ? `git fetch origin ${branch} timed out after ${boundMs}ms — network or VPN may be down`
        : `git fetch origin ${branch} failed: ${detail}`,
    };
  }
  try {
    const { stdout } = await git(repo, ["rev-parse", `origin/${branch}`]);
    return { ok: true, remoteSha: stdout.trim() };
  } catch (err) {
    return { ok: false, reason: `fetched origin ${branch} but origin/${branch} does not resolve: ${(err as Error).message}` };
  }
}

/** Whether `ancestor` is an ancestor of (or equal to) `descendant`. */
export async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(repo, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/**
 * NOT-219: fast-forward the managed clone's local `branch` ref to `sha` (the SHA a
 * developer push just published). Strictly a fast-forward — when the local ref has
 * commits the pushed SHA lacks (diverged or ahead), it is preserved untouched and
 * this returns false. Best-effort: returns false instead of throwing, so a caller
 * can safely ignore bookkeeping it cannot complete — the next repair round's fetch
 * heals a ref this missed anyway.
 */
export async function fastForwardLocalBranchToSha(opts: {
  repo: string;
  branch: string;
  sha: string;
}): Promise<boolean> {
  return withRepoLock(opts.repo, async () => {
    try {
      if (!(await branchExists(opts.repo, opts.branch))) {
        await git(opts.repo, ["branch", opts.branch, opts.sha]);
        return true;
      }
      const localSha = await revParseRef(opts.repo, `refs/heads/${opts.branch}`);
      if (localSha === opts.sha) return true;
      if (!(await isAncestor(opts.repo, localSha, opts.sha))) return false;
      await git(opts.repo, ["update-ref", `refs/heads/${opts.branch}`, opts.sha, localSha]);
      return true;
    } catch {
      return false;
    }
  });
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

/** Commit message for a timeout salvage tip (NOT-145). */
export const SALVAGE_TIMEOUT_MESSAGE = "wip: timeout salvage";
/** Commit message for a crash/non-zero exit salvage tip (NOT-145). */
export const SALVAGE_CRASH_MESSAGE = "wip: crash salvage";

export type SalvageResult =
  | { ok: true; commitSha: string; message: string }
  | { ok: false; reason: string };

/**
 * NOT-145: stage everything and commit a clearly marked salvage tip so a timeout/crash
 * can remove the worktree for retry without silently discarding uncommitted WIP.
 * Prefer this over leaving dirt behind — the durable checkpoint is the branch tip
 * (parent NOT-143), not a preserved dirty checkout the next attempt cannot adopt.
 */
export async function salvageDirtyWorktree(
  worktreePath: string,
  kind: "timeout" | "crash"
): Promise<SalvageResult> {
  const message = kind === "timeout" ? SALVAGE_TIMEOUT_MESSAGE : SALVAGE_CRASH_MESSAGE;
  try {
    await git(worktreePath, ["add", "-A"]);
    // Explicit identity: coordinator-managed worktrees may lack user.name/email, and a
    // salvage commit must not depend on whatever the agent happened to configure.
    await git(worktreePath, [
      "-c",
      "user.email=agent-dealer@localhost",
      "-c",
      "user.name=Agent Dealer",
      "commit",
      "-q",
      "-m",
      message,
    ]);
    // Lens (NOT-145): never report ok while the tree is still dirty — residual dirt would
    // make bestEffortRemove preserve the checkout and the next retry collide on the branch.
    const clean = await isWorktreeClean(worktreePath);
    if (!clean) {
      return {
        ok: false,
        reason: "salvage commit succeeded but the worktree is still dirty",
      };
    }
    const { stdout } = await git(worktreePath, ["rev-parse", "HEAD"]);
    return { ok: true, commitSha: stdout.trim(), message };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/** Actionable recovery lines for a preserved dirty developer checkout (NOT-137 / NOT-145). */
export function dirtyWorktreeRecoveryCommands(repo: string, worktreePath: string): string[] {
  return [
    `cd ${worktreePath}`,
    "git status",
    "git log --oneline -5",
    "git stash list",
    `git -C ${repo} worktree remove ${worktreePath}  # only after the work is saved`,
  ];
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

/** Resolve any ref (e.g. `origin/issue-…`) — used by publish-only retries that have no worktree. */
export async function revParseRef(repo: string, ref: string): Promise<string> {
  const { stdout } = await git(repo, ["rev-parse", ref]);
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

/**
 * Legacy layout: worktrees under `<repo>/.agent-dealer-worktrees/` (pre-NOT-149).
 * New managed checkouts use `roleWorktreePathForResolution` from managed-repo.ts;
 * callers that still pass a local repo path keep this helper for recovery.
 */
export function worktreesRoot(repo: string): string {
  return path.join(repo, WORKTREES_DIR_NAME);
}

export function roleWorktreePath(repo: string, sessionId: string, role: WorkerSessionRole): string {
  return path.join(worktreesRoot(repo), `${sessionId}-${role}`);
}

function ensureParentDir(worktreePath: string): void {
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
}

/** @deprecated use ensureParentDir — kept so any stray call sites compile during migration. */
function ensureWorktreesRoot(repo: string): void {
  fs.mkdirSync(worktreesRoot(repo), { recursive: true });
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
  /**
   * Explicit worktree path (NOT-149 managed layout). When omitted, falls back to the
   * legacy `<repo>/.agent-dealer-worktrees/<sessionId>-<role>` layout for recovery.
   */
  worktreePath?: string;
}): Promise<RoleWorktree> {
  const detached = opts.role === "reviewer";
  const worktreePath =
    opts.worktreePath ?? roleWorktreePath(opts.repo, opts.sessionId, opts.role);
  await withRepoLock(opts.repo, async () => {
    await pruneWorktrees(opts.repo);
    ensureParentDir(worktreePath);
    await addWorktree({
      repo: opts.repo,
      path: worktreePath,
      ref: opts.ref,
      detach: detached,
      newBranch: opts.newBranch,
    });
    if (detached) await blockPush(opts.repo, worktreePath);
  });
  return { path: tryRealpath(worktreePath), role: opts.role, ref: opts.newBranch ?? opts.ref, detached };
}

/**
 * Divergence facts gathered after a non-fast-forward (or equivalent) push rejection
 * (NOT-137). Attached so a `unpushed_commit` escalation is actionable — raw git stderr
 * alone repeats a misleading `git pull` hint for rewritten/diverged histories.
 */
export type PushRejectionFacts = {
  localSha: string;
  remoteSha: string;
  /** Commits reachable from local but not remote (`A...B` left count). */
  ahead: number;
  /** Commits reachable from remote but not local (`A...B` right count). */
  behind: number;
  /** `diverged` when both sides have unique commits; `behind` when only remote does. */
  relationship: "diverged" | "behind";
  /** Human-readable diagnosis — never git's `use 'git pull'` hint for diverged. */
  summary: string;
  recoveryCommands: string[];
};

export type PushResult =
  | { ok: true; leasePush?: { oldSha: string; newSha: string } }
  | { ok: false; reason: string; rejected: boolean; facts?: PushRejectionFacts };

const PUSH_REJECTION_PATTERNS = /rejected|non-fast-forward|fetch first|stale info/i;

function shortSha(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

/**
 * After a rejected push, fetch the remote tip and classify local vs origin/<branch>.
 * Best-effort: returns null when the remote tip cannot be resolved (facts stay out of
 * the escalation rather than inventing them).
 */
async function gatherPushRejectionFacts(opts: {
  cwd: string;
  branch: string;
  /** Local tip to compare — `HEAD` in a worktree, or `refs/heads/<branch>` for pushBranchRef. */
  localRef: string;
}): Promise<PushRejectionFacts | null> {
  try {
    // Refresh origin/<branch> so left/right counts reflect the tip that rejected us, not a
    // stale remote-tracking ref left over from an earlier fetch.
    await fetchRef(opts.cwd, opts.branch).catch(() => {});
    const remoteRef = `origin/${opts.branch}`;
    if (!(await refExists(opts.cwd, remoteRef))) return null;

    const localSha = await revParseRef(opts.cwd, opts.localRef);
    const remoteSha = await revParseRef(opts.cwd, remoteRef);
    const { stdout } = await git(opts.cwd, [
      "rev-list",
      "--left-right",
      "--count",
      `${localSha}...${remoteSha}`,
    ]);
    const parts = stdout.trim().split(/\s+/);
    const ahead = Number(parts[0]);
    const behind = Number(parts[1]);
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;

    // A non-fast-forward rejection always means remote has commits we lack (behind > 0).
    // When we also have unique commits, histories diverged — git's pull hint is wrong.
    const relationship: "diverged" | "behind" = ahead > 0 && behind > 0 ? "diverged" : "behind";

    const localShort = shortSha(localSha);
    const remoteShort = shortSha(remoteSha);

    let summary: string;
    let recoveryCommands: string[];
    if (relationship === "diverged") {
      summary =
        `local and origin/${opts.branch} have diverged: local ${localShort} is ${ahead} commit(s) ahead, ` +
        `remote ${remoteShort} is ${behind} commit(s) ahead. ` +
        `Do not git pull — that integrates the wrong history for a rewritten branch.`;
      recoveryCommands = [
        `# Confirm the remote tip is still ${remoteShort}, then publish local with a lease pin:`,
        `git push --force-with-lease=refs/heads/${opts.branch}:${remoteSha} origin ${localSha}:refs/heads/${opts.branch}`,
      ];
    } else {
      summary =
        `local ${localShort} is behind origin/${opts.branch} at ${remoteShort} ` +
        `(remote is ${behind} commit(s) ahead; local is ${ahead} commit(s) ahead).`;
      recoveryCommands = [
        `git fetch origin ${opts.branch}`,
        `git rebase origin/${opts.branch}`,
        `git push origin HEAD:refs/heads/${opts.branch}`,
      ];
    }

    return {
      localSha,
      remoteSha,
      ahead,
      behind,
      relationship,
      summary,
      recoveryCommands,
    };
  } catch {
    return null;
  }
}

/**
 * NOT-220: whether a rejected diverged push is provably safe to recover with a
 * lease-pinned force push. Returns the remote SHA to pin the lease to, or null
 * when today's `unpushed_commit` escalation must stand. ALL must hold:
 *
 * 1. The fetched remote tip is exactly the last head Dealer verified/pushed
 *    (`lastKnownHeadSha`) — anyone else having pushed since rules recovery out.
 * 2. Every remote-only commit has a patch-equivalent local counterpart:
 *    `git cherry <local> <remote>` lists the remote-only non-merge commits, one
 *    line each, `-` when an equivalent patch exists locally. (Note the argument
 *    order: head must be the remote so the lines enumerate remote-only commits.)
 * 3. The output is non-empty AND the remote-only range holds no merge commits —
 *    `git cherry` never lists merges, so a pure-merge range would otherwise be
 *    vacuously "all equivalent" with nothing actually proven.
 */
async function leasePushExpectedRemoteSha(opts: {
  cwd: string;
  localSha: string;
  remoteSha: string;
  lastKnownHeadSha: string | null | undefined;
}): Promise<string | null> {
  try {
    if (!opts.lastKnownHeadSha || opts.remoteSha !== opts.lastKnownHeadSha) return null;
    const { stdout } = await git(opts.cwd, ["cherry", opts.localSha, opts.remoteSha]);
    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) return null;
    if (!lines.every((l) => l.startsWith("-"))) return null;
    const { stdout: merges } = await git(opts.cwd, [
      "rev-list",
      "--merges",
      `${opts.localSha}..${opts.remoteSha}`,
    ]);
    if (merges.trim().length > 0) return null;
    return opts.remoteSha;
  } catch {
    return null;
  }
}

/**
 * NOT-220: the single lease-pinned retry. Pins the lease to the fetched remote
 * SHA — a race where origin moves between fetch and push makes this fail instead
 * of overwriting anyone's work. Same `-u` upstream tracking as the plain push.
 */
export async function pushWithLease(opts: {
  cwd: string;
  branch: string;
  localRef: string;
  expectedRemoteSha: string;
}): Promise<{ ok: true; newSha: string } | { ok: false; reason: string }> {
  try {
    await git(opts.cwd, [
      "push",
      "-u",
      "origin",
      `--force-with-lease=refs/heads/${opts.branch}:${opts.expectedRemoteSha}`,
      `${opts.localRef}:refs/heads/${opts.branch}`,
    ]);
    return { ok: true, newSha: await revParseRef(opts.cwd, opts.localRef) };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

async function pushFailureResult(
  cwd: string,
  branch: string,
  localRef: string,
  message: string,
  lastKnownHeadSha?: string | null
): Promise<PushResult> {
  const rejected = PUSH_REJECTION_PATTERNS.test(message);
  if (!rejected) return { ok: false, reason: message, rejected: false };
  const facts = await gatherPushRejectionFacts({ cwd, branch, localRef });
  if (!facts) return { ok: false, reason: message, rejected: true };
  // NOT-220: a divergence Dealer can prove safe to resolve (remote tip is the
  // last verified head, every remote-only commit patch-equivalent locally) is
  // retried once with the lease pin — no human action needed.
  if (facts.relationship === "diverged") {
    const pin = await leasePushExpectedRemoteSha({
      cwd,
      localSha: facts.localSha,
      remoteSha: facts.remoteSha,
      lastKnownHeadSha,
    });
    if (pin !== null) {
      const retried = await pushWithLease({ cwd, branch, localRef, expectedRemoteSha: pin });
      if (retried.ok) return { ok: true, leasePush: { oldSha: pin, newSha: retried.newSha } };
      // The lease lost its race (or the retry failed another way): re-gather so
      // the escalation names the tip that actually beat us, not the stale one.
      const fresh = await gatherPushRejectionFacts({ cwd, branch, localRef });
      if (fresh) return { ok: false, reason: fresh.summary, rejected: true, facts: fresh };
    }
  }
  // Prefer the classified summary over raw git stderr so the escalation never carries
  // git's misleading `use 'git pull'` hint for a diverged branch (NOT-137).
  return { ok: false, reason: facts.summary, rejected: true, facts };
}

/**
 * The coordinator — never the developer worker — pushes the branch, after the worker's
 * session has already ended (design §"Role permissions": the credentialed push effect
 * never runs inside the worker's own process; see profile-snapshot.ts's PermissionPolicy
 * doc comment for why this could never be an enforceable worker-side policy toggle).
 * Distinguishes a clean rejection (remote diverged — `unpushed_commit`, a policy_escalation
 * a human resolves) from an unexpected tooling failure (`adapter_failure`).
 */
export async function pushBranch(opts: {
  worktreePath: string;
  branch: string;
  /** NOT-220: the last head Dealer verified/pushed — enables the proven-equivalent lease retry. */
  lastKnownHeadSha?: string | null;
}): Promise<PushResult> {
  try {
    await git(opts.worktreePath, ["push", "-u", "origin", `HEAD:refs/heads/${opts.branch}`]);
    return { ok: true };
  } catch (err) {
    return pushFailureResult(
      opts.worktreePath,
      opts.branch,
      "HEAD",
      (err as Error).message,
      opts.lastKnownHeadSha
    );
  }
}

/**
 * Push an existing local branch by ref, from the repo itself rather than a checkout. The
 * republish path (NOT-129) recovers commits a dead attempt left on the branch, and by then
 * there is no worktree whose HEAD `pushBranch` could use — the branch ref in the shared repo
 * is the only durable handle on that work.
 */
export async function pushBranchRef(opts: {
  repo: string;
  branch: string;
  /** NOT-220: the last head Dealer verified/pushed — enables the proven-equivalent lease retry. */
  lastKnownHeadSha?: string | null;
}): Promise<PushResult> {
  try {
    await git(opts.repo, ["push", "-u", "origin", `refs/heads/${opts.branch}:refs/heads/${opts.branch}`]);
    return { ok: true };
  } catch (err) {
    return pushFailureResult(
      opts.repo,
      opts.branch,
      `refs/heads/${opts.branch}`,
      (err as Error).message,
      opts.lastKnownHeadSha
    );
  }
}

/**
 * NOT-221: publish already-finished commits over a diverged remote with a lease pinned
 * to the exact remote tip the operator reviewed (`remoteSha`, stored in the
 * push_with_lease action's evidence). The explicit `<localSha>:refs/heads/<branch>`
 * refspec pushes the recorded local tip even when the checkout's HEAD has since moved
 * (or the push runs from the repo rather than the preserved worktree).
 *
 * When origin no longer matches the pin the push fails and nothing is published — the
 * caller leaves the action open and shows the freshly observed tip instead.
 */
export async function pushLeaseToSha(opts: {
  cwd: string;
  branch: string;
  localSha: string;
  remoteSha: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await git(opts.cwd, [
      "push",
      `--force-with-lease=refs/heads/${opts.branch}:${opts.remoteSha}`,
      "origin",
      `${opts.localSha}:refs/heads/${opts.branch}`,
    ]);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * NOT-221: read origin's live tip for a branch without touching local refs — shown on
 * the still-open action after a lease push fails, so the operator sees what moved.
 * Null when the branch cannot be resolved remotely (deleted, renamed, or unreachable).
 */
export async function readRemoteTip(opts: { cwd: string; branch: string }): Promise<string | null> {
  try {
    const { stdout } = await git(opts.cwd, ["ls-remote", "origin", `refs/heads/${opts.branch}`]);
    const sha = stdout.trim().split(/\s+/)[0];
    return sha && /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Commits on HEAD not on `baseRef` — zero means the developer produced nothing to push/PR. */
export async function commitsAhead(opts: { worktreePath: string; baseRef: string }): Promise<number> {
  const { stdout } = await git(opts.worktreePath, ["rev-list", "--count", `${opts.baseRef}..HEAD`]);
  return Number(stdout.trim());
}

/** `commitsAhead` between two arbitrary refs — no worktree, no HEAD (see `pushBranchRef`). */
export async function countCommitsBetween(opts: {
  repo: string;
  base: string;
  head: string;
}): Promise<number> {
  const { stdout } = await git(opts.repo, ["rev-list", "--count", `${opts.base}..${opts.head}`]);
  return Number(stdout.trim());
}

/** Whether any ref (SHA, `origin/<branch>`, branch name) resolves to a commit in this repo. */
export async function refExists(repo: string, ref: string): Promise<boolean> {
  try {
    await git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The base→head diff, computed by the coordinator (not the reviewer worker — a claude
 * reviewer has no Bash tool at all, see prompts.ts's module doc) and embedded in the
 * reviewer prompt. Both SHAs must already be present as objects in `worktreePath`'s repo
 * — true for a reviewer worktree, since it shares object storage with the repo the
 * developer round already fetched/merge-based against.
 */
export async function diffShas(opts: { worktreePath: string; baseSha: string; headSha: string }): Promise<string> {
  const { stdout } = await git(opts.worktreePath, ["diff", opts.baseSha, opts.headSha]);
  return stdout;
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

/**
 * The checkout path currently holding `branch` in `repo`'s worktree list, if any — `git
 * worktree add`/checkout refuses a branch already checked out elsewhere, and the failure
 * message alone doesn't tell the caller whether that other checkout is safe to reuse. Reads
 * `git worktree list --porcelain`: entries are blank-line-separated blocks of `worktree
 * <path>` / `HEAD <sha>` / `branch refs/heads/<name>` (omitted entirely for a detached
 * checkout, which can never be the collision this looks for).
 */
export async function findWorktreeForBranch(repo: string, branch: string): Promise<string | null> {
  const { stdout } = await git(repo, ["worktree", "list", "--porcelain"]);
  const ref = `refs/heads/${branch}`;
  let currentPath: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) currentPath = line.slice("worktree ".length).trim();
    else if (line.startsWith("branch ") && line.slice("branch ".length).trim() === ref) return currentPath;
  }
  return null;
}

/** `git worktree list` resolves symlinks in the paths it reports (e.g. macOS's /tmp →
 * /private/tmp); comparing that against a literally-constructed path would misclassify a
 * coordinator-owned worktree as external. Falls back to the raw path if it doesn't exist. */
function tryRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

export type DeveloperWorktreeResolution =
  /**
   * A worktree was created. `baseSha`/`baseRef` name the commit a NEW branch was cut
   * from (NOT-197: the freshly fetched `origin/<base>`, recorded so the issue's base
   * SHA reflects the true branch point); both are null when no new branch was cut —
   * a fresh checkout of an already-existing branch for a retry.
   */
  | { kind: "created"; path: string; baseSha: string | null; baseRef: string | null }
  | { kind: "reused"; path: string }
  | { kind: "conflict"; path: string; reason: string; recoveryCommands: string[] }
  /** NOT-127: leftover is still owned by a session whose CLI is live — do not adopt or escalate. */
  | { kind: "live_owner"; path: string; ownerSessionId: string; reason: string }
  /**
   * NOT-197: the pre-branch `git fetch origin <base>` failed or timed out, so no fresh
   * branch could be cut from a known-current base — and no branch was created. The
   * caller defers the start instead of falling back to the stale local base.
   * NOT-219: the reuse path produces this too, when its pre-checkout
   * `git fetch origin <branch>` fails — starting from the stale local branch is
   * exactly the false-divergence bug, so the start is deferred the same way.
   */
  | { kind: "base_unavailable"; reason: string };

/**
 * Session id encoded in a coordinator-managed role worktree path
 * (`…/.agent-dealer-worktrees/<sessionId>-developer`). Returns null when the basename is
 * not that shape (external checkouts, hand-renamed dirs).
 */
export function sessionIdFromRoleWorktreePath(worktreePath: string): string | null {
  const base = path.basename(worktreePath);
  const m = /^(.*)-(developer|reviewer)$/.exec(base);
  return m?.[1] ?? null;
}

/** Whether a leftover worktree's owning session still has a live process (NOT-127). */
export type WorktreeOwnerLiveness =
  | { state: "dead" }
  | { state: "alive"; sessionId: string };

/**
 * The developer-setup half of design §"Worktree lifecycle and concurrency"'s crash-recovery
 * requirement: a leftover worktree from an earlier round/escalation on the SAME issue branch
 * must be detected before a fresh `git worktree add` collides with it, not left to surface as
 * an opaque git error. A clean leftover under this coordinator's own worktrees root is reused
 * in place (whatever commits it already carries are preserved); a dirty/unpushed one, or one
 * outside the coordinator's management, is reported as a conflict for a human to resolve
 * instead of being blindly retried — reusing or force-removing it here would silently discard
 * or hide work exactly like the dirty-handoff case this mirrors (`safeRemoveWorktree`).
 *
 * NOT-127: before reuse or conflict, `ownerLiveness` (when provided) asks whether the
 * session that owns the leftover still has a live process. A live owner is neither adopted
 * nor escalated as a worktree conflict — that is the same-worker case. Omitting the check
 * preserves the pre-NOT-127 filesystem-only behaviour (dead owner).
 */
export async function resolveDeveloperWorktree(opts: {
  repo: string;
  sessionId: string;
  branchName: string;
  baseBranch: string;
  reuseBranch: boolean;
  /**
   * NOT-149: managed worktree path. When set, new checkouts use this path and leftover
   * detection looks under its parent directory instead of `<repo>/.agent-dealer-worktrees`.
   */
  worktreePath?: string;
  ownerLiveness?: (worktreePath: string) => WorktreeOwnerLiveness | Promise<WorktreeOwnerLiveness>;
  /**
   * NOT-197: bound for the pre-branch `git fetch origin <baseBranch>` on the
   * fresh-branch path (and NOT-219: for the pre-checkout
   * `git fetch origin <branchName>` on the reuse path).
   * Defaults to {@link DEFAULT_BASE_FETCH_TIMEOUT_MS}.
   */
  fetchTimeoutMs?: number;
}): Promise<DeveloperWorktreeResolution> {
  return withRepoLock(opts.repo, async () => {
    await pruneWorktrees(opts.repo);
    // NOT-219: a repair round reuses an existing issue branch, so first fetch
    // `origin/<branch>` — the worktree must start at exactly what Dealer pushed,
    // never the managed clone's possibly-stale local ref. A failed fetch defers the
    // start (`base_unavailable`) instead of falling back to the stale local branch.
    let reuseRemoteSha: string | null = null;
    if (opts.reuseBranch) {
      const reused = await fetchReusedBranch(opts.repo, opts.branchName, opts.fetchTimeoutMs);
      if (!reused.ok) {
        return { kind: "base_unavailable", reason: reused.reason };
      }
      reuseRemoteSha = reused.remoteSha;
    }
    const existing = await findWorktreeForBranch(opts.repo, opts.branchName);
    if (existing) {
      const managedRoot = opts.worktreePath
        ? tryRealpath(path.dirname(opts.worktreePath))
        : tryRealpath(worktreesRoot(opts.repo));
      const underRoot = tryRealpath(existing).startsWith(managedRoot + path.sep);
      if (!underRoot) {
        return {
          kind: "conflict",
          path: existing,
          reason: `Branch ${opts.branchName} is already checked out at ${existing}, outside the coordinator's managed worktrees — it cannot be safely reused or removed automatically.`,
          recoveryCommands: [`git -C ${opts.repo} worktree list`, `# free the branch, then Resume: cd ${existing} && git status`],
        };
      }
      // Live owner first — clean/dirty are only meaningful once the predecessor is gone.
      const owner = opts.ownerLiveness ? await opts.ownerLiveness(existing) : { state: "dead" as const };
      if (owner.state === "alive") {
        return {
          kind: "live_owner",
          path: tryRealpath(existing),
          ownerSessionId: owner.sessionId,
          reason: `Developer worktree for branch ${opts.branchName} at ${existing} is still in use by session ${owner.sessionId} (live process) — refusing to adopt it or escalate as a worktree conflict.`,
        };
      }
      const state = await inspectLeftoverWorktree(existing);
      if (state === "clean") {
        // NOT-219: a clean leftover holding a stale local branch advances to the
        // fetched remote tip when that is a strict fast-forward (nothing unique to
        // lose — the local tip is already an ancestor of the remote one). Any other
        // relationship (ahead, diverged) keeps the leftover exactly as-is.
        if (reuseRemoteSha !== null) {
          const localSha = await revParseRef(opts.repo, `refs/heads/${opts.branchName}`).catch(() => null);
          if (
            localSha !== null &&
            localSha !== reuseRemoteSha &&
            (await isAncestor(opts.repo, localSha, reuseRemoteSha))
          ) {
            await git(existing, ["merge", "--ff-only", "-q", `origin/${opts.branchName}`]).catch(() => null);
          }
        }
        return { kind: "reused", path: tryRealpath(existing) };
      }
      if (state === "dirty_or_unpushed") {
        return {
          kind: "conflict",
          path: existing,
          reason: `A previous developer worktree for branch ${opts.branchName} still holds it at ${existing} with uncommitted changes.`,
          recoveryCommands: [
            `cd ${existing}`,
            "git status",
            "git log --oneline -5",
            `# once the work there is safe (pushed or intentionally discarded): git -C ${opts.repo} worktree remove ${existing} --force`,
          ],
        };
      }
      // inspectLeftoverWorktree reports "missing" for ANY `git status` failure, not just a
      // deleted directory (a review round flagged this: a corrupt/unreadable checkout that's
      // still on disk and still registered would otherwise be silently reinterpreted as a
      // harmless stale entry, pruned as a no-op, and immediately re-collide on the `addWorktree`
      // below — a narrower repeat of the exact loop this function exists to close). Only a
      // truly gone directory is safe to treat as a stale administrative entry.
      if (fs.existsSync(existing)) {
        return {
          kind: "conflict",
          path: existing,
          reason: `A previous developer worktree for branch ${opts.branchName} exists at ${existing} but its status could not be determined.`,
          recoveryCommands: [
            `cd ${existing}`,
            "git status",
            `# once resolved: git -C ${opts.repo} worktree remove ${existing} --force`,
          ],
        };
      }
      await pruneWorktrees(opts.repo);
    }
    // NOT-197: a fresh issue branch starts from the freshly fetched
    // `origin/<baseBranch>` tip — never the cached clone's possibly-stale local base.
    // A failed fetch returns `base_unavailable` (no branch is created) instead of
    // silently falling back to the stale local branch.
    let ref: string;
    let newBranch: string | undefined;
    let baseSha: string | null = null;
    let baseRef: string | null = null;
    if (!opts.reuseBranch) {
      const fresh = await fetchFreshBase(opts.repo, opts.baseBranch, opts.fetchTimeoutMs);
      if (!fresh.ok) {
        return { kind: "base_unavailable", reason: fresh.reason };
      }
      ref = fresh.ref;
      newBranch = opts.branchName;
      baseSha = fresh.sha;
      baseRef = fresh.ref;
    } else if (reuseRemoteSha !== null && !(await branchExists(opts.repo, opts.branchName))) {
      // NOT-219: the remote has the issue branch but the clone has no local ref for
      // it (e.g. round 1 committed on a side branch and never created the local
      // issue branch) — cut it at the fetched `origin/<branch>` tip.
      ref = `origin/${opts.branchName}`;
      newBranch = opts.branchName;
    } else {
      // NOT-219: when the remote tip is known and the local ref is strictly behind
      // it (an ancestor of it), advance the local ref to the pushed tip before
      // checking it out — the repair worktree then starts at HEAD == origin/<branch>.
      // A local ref with commits the remote lacks (ahead or diverged) is preserved
      // untouched: it is checked out as-is, exactly like the pre-NOT-219 behavior.
      if (reuseRemoteSha !== null && (await branchExists(opts.repo, opts.branchName))) {
        const localSha = await revParseRef(opts.repo, `refs/heads/${opts.branchName}`);
        if (localSha !== reuseRemoteSha && (await isAncestor(opts.repo, localSha, reuseRemoteSha))) {
          await git(opts.repo, ["update-ref", `refs/heads/${opts.branchName}`, reuseRemoteSha, localSha]);
        }
      }
      ref = opts.branchName;
      newBranch = undefined;
    }
    const worktreePath =
      opts.worktreePath ?? roleWorktreePath(opts.repo, opts.sessionId, "developer");
    ensureParentDir(worktreePath);
    await addWorktree({
      repo: opts.repo,
      path: worktreePath,
      ref,
      detach: false,
      newBranch,
    });
    return { kind: "created", path: tryRealpath(worktreePath), baseSha, baseRef };
  });
}
