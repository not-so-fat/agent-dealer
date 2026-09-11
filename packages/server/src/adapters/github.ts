// packages/server/src/adapters/github.ts
//
// The coordinator's read/verify boundary onto GitHub via `gh`. Review bodies and PR
// bodies are always written to a file and passed with `--body-file`, never shell-
// interpolated (design §"Role permissions and GitHub access"). Only the developer-handoff
// slice lives here for NOT-61 — `publishReview`'s same-identity-comment fallback is NOT-62
// scope and is added when the reviewer effect handler needs it.
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
}

interface RawPrView {
  number: number;
  url: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
}

export function parsePrView(json: string): PrView {
  const raw = JSON.parse(json) as RawPrView;
  return {
    number: raw.number,
    url: raw.url,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    headRefOid: raw.headRefOid,
  };
}

const PR_VIEW_FIELDS = "number,url,baseRefName,headRefName,headRefOid";

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
]);
const PENDING_STATES = new Set(["pending", "queued", "in_progress", "expected", "waiting"]);

export function summarizeChecks(rollup: RawCheck[]): ChecksSnapshot {
  if (rollup.length === 0) return "none";
  const stateOf = (c: RawCheck): string => (c.conclusion || c.state || c.status || "").toLowerCase();
  if (rollup.some((c) => FAILURE_STATES.has(stateOf(c)))) return "failure";
  if (rollup.some((c) => PENDING_STATES.has(stateOf(c)))) return "pending";
  return "success";
}

export type CreatePrResult = { ok: true; number: number; url: string } | { ok: false; reason: string; noCommits: boolean };

const NO_COMMITS_PATTERN = /no commits between/i;

export interface GithubAdapter {
  /** null when no PR exists yet for the current branch. */
  viewPr(opts: { cwd: string }): Promise<PrView | null>;
  createDraftPr(opts: { cwd: string; base: string; title: string; bodyFilePath: string }): Promise<CreatePrResult>;
  /** One-shot read of the current check rollup for the PR's head. */
  checksSnapshot(opts: { cwd: string }): Promise<ChecksSnapshot>;
}

async function ghPrView(cwd: string, fields: string): Promise<Record<string, unknown> | null> {
  try {
    const { stdout } = await run("gh", ["pr", "view", "--json", fields], { cwd });
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch (err) {
    const message = (err as { stderr?: string; message: string }).stderr ?? (err as Error).message;
    if (/no pull requests found|no default remote|could not find/i.test(message)) return null;
    throw new Error(`gh pr view failed: ${message}`);
  }
}

export const realGithubAdapter: GithubAdapter = {
  async viewPr({ cwd }) {
    const raw = await ghPrView(cwd, PR_VIEW_FIELDS);
    return raw ? parsePrView(JSON.stringify(raw)) : null;
  },

  async createDraftPr({ cwd, base, title, bodyFilePath }) {
    try {
      const { stdout } = await run(
        "gh",
        ["pr", "create", "--draft", "--base", base, "--title", title, "--body-file", bodyFilePath],
        { cwd }
      );
      const view = await ghPrView(cwd, "number,url");
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
    const raw = await ghPrView(cwd, "statusCheckRollup");
    const rollup = (raw?.statusCheckRollup as RawCheck[] | undefined) ?? [];
    return summarizeChecks(rollup);
  },
};

export type PollChecksResult = "success" | "failure" | "timeout" | "none";

/**
 * Bounded poll for CI checks to resolve — the confirmed scope call for NOT-61 (vs a
 * one-shot read): "pending" keeps polling, "none"/"success" return immediately, "failure"
 * returns immediately, and the poll gives up as "timeout" if nothing resolves in time or
 * the lease is lost (`signal` aborts) mid-poll.
 */
export async function pollPrChecks(
  adapter: GithubAdapter,
  opts: { cwd: string; timeoutMs: number; intervalMs: number; signal?: AbortSignal }
): Promise<PollChecksResult> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    if (opts.signal?.aborted) return "timeout";
    const snapshot = await adapter.checksSnapshot({ cwd: opts.cwd });
    if (snapshot !== "pending") return snapshot;
    if (Date.now() >= deadline) return "timeout";
    await new Promise((resolve) => setTimeout(resolve, Math.min(opts.intervalMs, deadline - Date.now())));
  }
}
