// packages/server/src/adapters/worktree-deps.ts
//
// NOT-315: provision dependencies in a fresh developer worktree before the
// session spawns. The Muse builder sandbox has no network (restricted mode:
// DNS and loopback listen() both fail), so an in-session `npm install` can
// never work — the coordinator runs it here instead, outside the sandbox,
// with network.
//
// Only npm is in scope: a lockfile for another package manager (or no
// lockfile at all) skips the step with a logged reason, never a failure.
// A failed or timed-out install throws — the caller turns that into a
// visible `adapter_failure` worktree-setup failure (retryable on the existing
// infra-retry path), never a silent skip.
//
// The command runner is an injectable seam so tests prove the exact argv/cwd
// without spending network or touching a registry.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Default bound for `npm ci` in a fresh worktree (NOT-315). */
export const DEFAULT_WORKTREE_DEPS_TIMEOUT_MS = 5 * 60_000;

/** Bounded timeout for the install step; env override for tests/operators. */
export function worktreeDepsTimeoutMs(): number {
  const raw = Number(process.env.WORKTREE_DEPS_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WORKTREE_DEPS_TIMEOUT_MS;
}

/** Exact install invocation — asserted by tests, never drifted silently. */
export const NPM_CI_ARGS = ["ci", "--prefer-offline", "--no-audit", "--no-fund"] as const;

/** Lockfiles that mean "another package manager owns this worktree" — npm is out of scope. */
const NON_NPM_LOCKFILES = ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"] as const;

/** Last bytes of install output kept in the failure reason (a full log would drown routing). */
const STDERR_TAIL_CHARS = 2000;

export interface WorktreeDepsRunOpts {
  cwd: string;
  timeoutMs: number;
}

export type WorktreeDepsRunner = (
  cmd: string,
  args: readonly string[],
  opts: WorktreeDepsRunOpts
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: WorktreeDepsRunner = async (cmd, args, opts) =>
  run(cmd, [...args], { cwd: opts.cwd, timeout: opts.timeoutMs });

export type WorktreeDepsResult =
  | { ran: true; durationMs: number }
  | { ran: false; reason: string; durationMs: number };

/** Keep the failure reason actionable: the tail of what npm actually printed. */
export function stderrTail(err: unknown): string {
  const e = err as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const raw =
    (typeof e?.stderr === "string" && e.stderr.trim() ? e.stderr : null) ??
    (typeof e?.stdout === "string" && e.stdout.trim() ? e.stdout : null) ??
    (typeof e?.message === "string" && e.message ? e.message : String(err));
  const trimmed = raw.trim();
  return trimmed.length > STDERR_TAIL_CHARS ? trimmed.slice(-STDERR_TAIL_CHARS) : trimmed;
}

/**
 * Run `npm ci` in `worktreePath` when the checkout declares npm dependencies
 * that are not installed yet. Returns whether the install ran (with its
 * duration) or why it was skipped. Throws
 * `dependency install failed: <stderr tail>` when the install itself fails or
 * times out — the caller surfaces that as a worktree-setup `adapter_failure`.
 */
export async function ensureWorktreeDeps(
  worktreePath: string,
  opts: { runner?: WorktreeDepsRunner; timeoutMs?: number } = {}
): Promise<WorktreeDepsResult> {
  const startedAt = Date.now();
  const skipped = (reason: string): WorktreeDepsResult => ({
    ran: false,
    reason,
    durationMs: Date.now() - startedAt,
  });
  if (fs.existsSync(path.join(worktreePath, "node_modules"))) {
    return skipped("node_modules present");
  }
  if (!fs.existsSync(path.join(worktreePath, "package.json"))) {
    return skipped("no package.json");
  }
  for (const lock of NON_NPM_LOCKFILES) {
    if (fs.existsSync(path.join(worktreePath, lock))) {
      return skipped(`non-npm lockfile ${lock} present; only npm is in scope`);
    }
  }
  if (!fs.existsSync(path.join(worktreePath, "package-lock.json"))) {
    return skipped("no lockfile");
  }
  const timeoutMs = opts.timeoutMs ?? worktreeDepsTimeoutMs();
  const runner = opts.runner ?? defaultRunner;
  try {
    await runner("npm", NPM_CI_ARGS, { cwd: worktreePath, timeoutMs });
  } catch (err) {
    // A failed `npm ci` (or a timeout kill mid-reify) can leave a
    // partial/empty node_modules behind. The setup failure retries on the
    // infra path, which reuses the leftover worktree — and a leftover
    // node_modules would make the retry skip the install and hand the builder
    // broken deps. Remove it so the retry reinstalls from scratch; the removal
    // itself is best-effort and must never mask the install error.
    try {
      fs.rmSync(path.join(worktreePath, "node_modules"), { recursive: true, force: true });
    } catch {
      // keep the original install error below
    }
    const killed = (err as { killed?: unknown })?.killed === true;
    const prefix = killed ? `timed out after ${timeoutMs}ms: ` : "";
    throw new Error(`dependency install failed: ${prefix}${stderrTail(err)}`);
  }
  return { ran: true, durationMs: Date.now() - startedAt };
}
