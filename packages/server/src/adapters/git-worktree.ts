// packages/server/src/adapters/git-worktree.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

export async function isWorktreeClean(path: string): Promise<boolean> {
  const { stdout } = await git(path, ["status", "--porcelain"]);
  return stdout.trim().length === 0;
}

export async function mergeBase(opts: { repo: string; base: string; head: string }): Promise<string> {
  const { stdout } = await git(opts.repo, ["merge-base", opts.base, opts.head]);
  return stdout.trim();
}

export async function pruneWorktrees(repo: string): Promise<void> {
  await git(repo, ["worktree", "prune"]);
}

const repoLocks = new Map<string, Promise<unknown>>();

/** Serializes worktree add/remove for one repo so concurrent sessions never race .git metadata. */
export function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const prior = repoLocks.get(repo) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  repoLocks.set(
    repo,
    next.catch(() => undefined)
  );
  return next;
}
