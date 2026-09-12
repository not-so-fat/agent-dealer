// packages/server/src/adapters/github.ts
//
// The coordinator's read/verify boundary onto GitHub via `gh`. Review bodies and PR
// bodies are always written to a file and passed with `--body-file`, never shell-
// interpolated (design §"Role permissions and GitHub access"). `publishReview` (NOT-62)
// is called from the coordinator process itself, never the reviewer worker — the reviewer
// profile's `publishReview` PermissionPolicy flag is always false; "the coordinator... is
// the only component that publishes the review result" (design §"Role permissions").
//
// `GithubAdapter` is the injectable seam: production code uses `realGithubAdapter` (shells
// out to the real `gh` CLI), while tests inject a fake — no real GitHub calls, matching the
// "controlled GitHub adapter fixture" the NOT-61 acceptance criteria asks for.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface PrView {
  number: number;
  url: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  isDraft: boolean;
}

interface RawPrView {
  number: number;
  url: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  isDraft: boolean;
}

export function parsePrView(json: string): PrView {
  const raw = JSON.parse(json) as RawPrView;
  return {
    number: raw.number,
    url: raw.url,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    headRefOid: raw.headRefOid,
    isDraft: raw.isDraft,
  };
}

export const PR_VIEW_FIELDS = "number,url,baseRefName,headRefName,headRefOid,isDraft";

/** Raw per-check state as `gh` reports it — provider vocabulary varies (checks vs statuses). */
interface RawCheck {
  state?: string;
  status?: string;
  conclusion?: string;
}

export type ChecksSnapshot = "success" | "failure" | "pending" | "none";

const FAILURE_STATES = new Set([
  "failure",
  "error",
  "cancelled",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
]);
const PENDING_STATES = new Set(["pending", "queued", "in_progress", "expected", "waiting", "requested"]);
/** Every terminal-and-genuinely-ok conclusion `gh` can report — anything else fails closed. */
const SUCCESS_STATES = new Set(["success", "neutral", "skipped"]);

export function summarizeChecks(rollup: RawCheck[]): ChecksSnapshot {
  if (rollup.length === 0) return "none";
  const states = rollup.map((c) => (c.conclusion || c.state || c.status || "").toLowerCase());
  if (states.some((s) => FAILURE_STATES.has(s))) return "failure";
  if (states.some((s) => PENDING_STATES.has(s))) return "pending";
  if (states.every((s) => SUCCESS_STATES.has(s))) return "success";
  // An unrecognized terminal conclusion is never treated as success — fail closed rather
  // than silently waving a handoff through on a vocabulary this code doesn't know yet.
  return "failure";
}

export type CreatePrResult = { ok: true; number: number; url: string } | { ok: false; reason: string; noCommits: boolean };

const NO_COMMITS_PATTERN = /no commits between/i;

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export type PublishReviewResult =
  | { ok: true; event: ReviewEvent; usedCommentFallback: boolean }
  | { ok: false; reason: string };

export interface GithubAdapter {
  /**
   * null when no PR exists yet for the current branch. `number`, when given, views that
   * PR explicitly instead of resolving "the PR for the current branch" — required for a
   * detached-HEAD reviewer worktree, which has no current branch for `gh` to infer from.
   * `branch`, when given (and `number` is not), views the PR by that explicit branch name
   * instead of relying on `gh`'s current-branch/upstream inference — required when the
   * coordinator's generated branch exists on `origin` but the local checkout has no
   * configured upstream (NOT-82); the coordinator always knows this branch name already
   * and must never ask `gh` to infer it.
   */
  viewPr(opts: { cwd: string; number?: number; branch?: string }): Promise<PrView | null>;
  /**
   * `head` is always the coordinator-owned issue branch, passed explicitly as `--head` —
   * `gh pr create` refuses to infer it from the current branch when that branch has no
   * configured upstream, even though it was just pushed (NOT-82).
   */
  createDraftPr(opts: { cwd: string; base: string; head: string; title: string; bodyFilePath: string }): Promise<CreatePrResult>;
  /** One-shot read of the current check rollup for the PR's head. */
  checksSnapshot(opts: { cwd: string }): Promise<ChecksSnapshot>;
  /**
   * Publishes the reviewer's validated verdict against `number` explicitly — required for
   * a detached-HEAD reviewer worktree, same reason as `viewPr`'s `number`. `event`
   * "APPROVE"/"REQUEST_CHANGES" falls back to a plain comment review carrying the same
   * body when GitHub rejects it because the identity running `gh` authored the PR —
   * expected in this system's single-ambient-identity setup (design §"Role permissions":
   * developer and coordinator share one `gh auth`), not an edge case. The internal verdict
   * stays the workflow authority either way.
   *
   * Deliberately does NOT check GitHub for an existing review before submitting — the
   * caller (`reviewer-effect.ts`) is responsible for the once-only-publish guarantee via
   * a durable DB claim (`repository/review-publications.ts`). Two review rounds found a
   * GitHub-side "does a review already exist" lookup could not provide that guarantee on
   * its own (over-broad identity matching, then a check-then-publish race either way);
   * the DB claim is the single source of truth instead.
   */
  publishReview(opts: { cwd: string; number: number; event: ReviewEvent; bodyFilePath: string }): Promise<PublishReviewResult>;
}

/** The `gh` shell-out, as a seam: production uses `run("gh", ...)`, tests inject a fake that records exact args. */
export type GhExec = (args: string[], opts: { cwd: string }) => Promise<{ stdout: string }>;

const defaultExec: GhExec = (args, opts) => run("gh", args, opts);

async function ghPrView(exec: GhExec, cwd: string, fields: string, selector?: string): Promise<Record<string, unknown> | null> {
  const args = ["pr", "view", ...(selector != null ? [selector] : []), "--json", fields];
  try {
    const { stdout } = await exec(args, { cwd });
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch (err) {
    const message = (err as { stderr?: string; message: string }).stderr ?? (err as Error).message;
    if (/no pull requests found|no default remote|could not find/i.test(message)) return null;
    throw new Error(`gh pr view failed: ${message}`);
  }
}

/** Real `gh` adapter, parameterized over the shell-out so tests can assert exact CLI args without a real `gh`. */
export function createGithubAdapter(exec: GhExec = defaultExec): GithubAdapter {
  return {
    async viewPr({ cwd, number, branch }) {
      const selector = number != null ? String(number) : branch;
      const raw = await ghPrView(exec, cwd, PR_VIEW_FIELDS, selector);
      return raw ? parsePrView(JSON.stringify(raw)) : null;
    },

    async createDraftPr({ cwd, base, head, title, bodyFilePath }) {
      try {
        const { stdout } = await exec(
          ["pr", "create", "--draft", "--base", base, "--head", head, "--title", title, "--body-file", bodyFilePath],
          { cwd }
        );
        // Re-verified by the same explicit branch — a bare `gh pr view` right after this
        // can hit the identical no-upstream failure `gh pr create` needed `--head` for.
        const view = await ghPrView(exec, cwd, "number,url", head);
        if (view) return { ok: true, number: Number(view.number), url: String(view.url) };
        // Fallback: `gh pr create` prints the PR URL on its last stdout line.
        const url = stdout.trim().split("\n").pop() ?? "";
        const match = url.match(/\/pull\/(\d+)/);
        return { ok: true, number: match ? Number(match[1]) : 0, url };
      } catch (err) {
        const message = (err as { stderr?: string; message: string }).stderr ?? (err as Error).message;
        return { ok: false, reason: message, noCommits: NO_COMMITS_PATTERN.test(message) };
      }
    },

    async checksSnapshot({ cwd }) {
      const raw = await ghPrView(exec, cwd, "statusCheckRollup");
      const rollup = (raw?.statusCheckRollup as RawCheck[] | undefined) ?? [];
      return summarizeChecks(rollup);
    },

    async publishReview({ cwd, number, event, bodyFilePath }) {
      const result = await runReview(exec, cwd, number, event, bodyFilePath);
      if (result.ok || event === "COMMENT" || !OWN_PR_REVIEW_PATTERN.test(result.reason)) {
        return result.ok ? { ok: true, event, usedCommentFallback: false } : result;
      }
      const fallback = await runReview(exec, cwd, number, "COMMENT", bodyFilePath);
      return fallback.ok
        ? { ok: true, event: "COMMENT", usedCommentFallback: true }
        : { ok: false, reason: `${event} rejected as self-review, and comment fallback also failed: ${fallback.reason}` };
    },
  };
}

export const realGithubAdapter: GithubAdapter = createGithubAdapter();

const REVIEW_FLAG: Record<ReviewEvent, string> = {
  APPROVE: "--approve",
  REQUEST_CHANGES: "--request-changes",
  COMMENT: "--comment",
};

/** GitHub's self-review rejection, worded per event ("approve" / "request changes"). */
const OWN_PR_REVIEW_PATTERN = /own pull request/i;

async function runReview(
  exec: GhExec,
  cwd: string,
  number: number,
  event: ReviewEvent,
  bodyFilePath: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    // The PR is targeted explicitly by number — the reviewer's worktree is a detached-HEAD
    // checkout with no current branch for a bare `gh pr review` to resolve against.
    await exec(["pr", "review", String(number), REVIEW_FLAG[event], "--body-file", bodyFilePath], { cwd });
    return { ok: true };
  } catch (err) {
    const message = (err as { stderr?: string; message: string }).stderr ?? (err as Error).message;
    return { ok: false, reason: message };
  }
}

export type PollChecksResult = "success" | "failure" | "timeout" | "none";

/** Consecutive "none" reads required before concluding no checks are configured at all. */
const NONE_STREAK_REQUIRED = 2;

/**
 * Bounded poll for CI checks to resolve — the confirmed scope call for NOT-61 (vs a
 * one-shot read): "pending" keeps polling, "success"/"failure" return immediately once
 * seen, and the poll gives up as "timeout" if nothing resolves in time or the lease is
 * lost (`signal` aborts) mid-poll.
 *
 * "none" is NOT returned on the first read: GitHub can briefly report an empty
 * statusCheckRollup before Actions has created its check runs, so a one-shot "empty
 * rollup ⇒ no checks configured" read races a PR straight past CI — a review round caught
 * this letting a real handoff through before its checks even appeared. `none` is only
 * accepted once it has been read `NONE_STREAK_REQUIRED` times in a row (any "pending" in
 * between resets the streak); if the deadline is hit before that streak completes, the
 * poll fails closed as "timeout" rather than silently waving the handoff through.
 */
export async function pollPrChecks(
  adapter: GithubAdapter,
  opts: { cwd: string; timeoutMs: number; intervalMs: number; signal?: AbortSignal }
): Promise<PollChecksResult> {
  const deadline = Date.now() + opts.timeoutMs;
  let noneStreak = 0;
  for (;;) {
    if (opts.signal?.aborted) return "timeout";
    const snapshot = await adapter.checksSnapshot({ cwd: opts.cwd });
    if (snapshot === "failure" || snapshot === "success") return snapshot;
    if (snapshot === "none") {
      noneStreak++;
      if (noneStreak >= NONE_STREAK_REQUIRED) return "none";
    } else {
      noneStreak = 0;
    }
    if (Date.now() >= deadline) return "timeout";
    await new Promise((resolve) => setTimeout(resolve, Math.min(opts.intervalMs, deadline - Date.now())));
  }
}
