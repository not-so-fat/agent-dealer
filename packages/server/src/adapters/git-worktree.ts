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
  | { ok: true }
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

async function pushFailureResult(
  cwd: string,
  branch: string,
  localRef: string,
  message: string
): Promise<Extract<PushResult, { ok: false }>> {
  const rejected = PUSH_REJECTION_PATTERNS.test(message);
  if (!rejected) return { ok: false, reason: message, rejected: false };
  const facts = await gatherPushRejectionFacts({ cwd, branch, localRef });
  if (facts) {
    // Prefer the classified summary over raw git stderr so the escalation never carries
    // git's misleading `use 'git pull'` hint for a diverged branch (NOT-137).
    return { ok: false, reason: facts.summary, rejected: true, facts };
  }
  return { ok: false, reason: message, rejected: true };
}

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
    return pushFailureResult(opts.worktreePath, opts.branch, "HEAD", (err as Error).message);
  }
}

/**
 * Push an existing local branch by ref, from the repo itself rather than a checkout. The
 * republish path (NOT-129) recovers commits a dead attempt left on the branch, and by then
 * there is no worktree whose HEAD `pushBranch` could use — the branch ref in the shared repo
 * is the only durable handle on that work.
 */
export async function pushBranchRef(opts: { repo: string; branch: string }): Promise<PushResult> {
  try {
    await git(opts.repo, ["push", "-u", "origin", `refs/heads/${opts.branch}:refs/heads/${opts.branch}`]);
    return { ok: true };
  } catch (err) {
    return pushFailureResult(
      opts.repo,
      opts.branch,
      `refs/heads/${opts.branch}`,
      (err as Error).message
    );
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
  | { kind: "created" | "reused"; path: string }
  | { kind: "conflict"; path: string; reason: string; recoveryCommands: string[] }
  /** NOT-127: leftover is still owned by a session whose CLI is live — do not adopt or escalate. */
  | { kind: "live_owner"; path: string; ownerSessionId: string; reason: string };

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
}): Promise<DeveloperWorktreeResolution> {
  return withRepoLock(opts.repo, async () => {
    await pruneWorktrees(opts.repo);
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
    const worktreePath =
      opts.worktreePath ?? roleWorktreePath(opts.repo, opts.sessionId, "developer");
    ensureParentDir(worktreePath);
    await addWorktree({
      repo: opts.repo,
      path: worktreePath,
      ref: opts.reuseBranch ? opts.branchName : opts.baseBranch,
      detach: false,
      newBranch: opts.reuseBranch ? undefined : opts.branchName,
    });
    return { kind: "created", path: tryRealpath(worktreePath) };
  });
}
