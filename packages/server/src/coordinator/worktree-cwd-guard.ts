// packages/server/src/coordinator/worktree-cwd-guard.ts
//
// NOT-273: defensive guard on the developer/reviewer spawn path. The worktree
// resolution (`resolveDeveloperWorktree` / `roleWorktreePathForResolution`) is
// correct today, but nothing asserts the resolved cwd before a child process
// is spawned — a regression there would run agent CLIs against the wrong
// directory (in the worst case the primary repo checkout itself, where a
// worker's `git add . && git commit` lands real commits on the checkout).
// Every real developer/reviewer spawn calls `assertWorktreeCwd` first and
// throws instead of spawning when the cwd is not a recognized
// coordinator-managed worktree path.

import path from "node:path";

/** Basename shape the worktree manager itself uses: `<sessionId>-<role>`. */
const ROLE_SUFFIX_RE = /-(developer|reviewer)$/;

/**
 * Parent directory names under which coordinator-managed role worktrees live:
 * - legacy layout: `<repo>/.agent-dealer-worktrees/<sessionId>-<role>`
 * - managed layout (NOT-149): `<executionRoot>/worktrees/<identity>/<sessionId>-<role>`
 * - dev-mode equivalent: `<dataDir>/worktrees/...`
 */
const WORKTREE_PARENT_NAMES = new Set([".agent-dealer-worktrees", "worktrees"]);

/**
 * True when `cwd` looks like a coordinator-managed role worktree path: its
 * basename carries the `-developer`/`-reviewer` role suffix AND one of its
 * parent directories is a recognized worktrees root. In particular the
 * primary repo root itself never matches (no role suffix, no worktrees
 * parent), nor does the ambient `process.cwd()` of a dev checkout.
 */
export function isManagedWorktreeCwd(cwd: string): boolean {
  if (typeof cwd !== "string" || cwd.length === 0) return false;
  const normalized = path.normalize(cwd);
  if (!ROLE_SUFFIX_RE.test(path.basename(normalized))) return false;
  const segments = normalized.split(path.sep).filter(Boolean);
  return segments.slice(0, -1).some((segment) => WORKTREE_PARENT_NAMES.has(segment));
}

/**
 * Throw instead of spawning when `cwd` is not a recognized managed-worktree
 * path. Called at the top of `realDeveloperSpawn`/`realReviewerSpawn`, before
 * any child process exists — the effects turn this pre-spawn throw into a
 * `session_failed` "could not start" outcome, never a run against the repo.
 */
export function assertWorktreeCwd(cwd: string): void {
  if (!isManagedWorktreeCwd(cwd)) {
    throw new Error(
      `Refusing to spawn a worker outside a managed worktree (NOT-273): ${cwd}`
    );
  }
}
