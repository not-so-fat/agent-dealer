// packages/server/src/adapters/github.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface PrView {
  number: number;
  url: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  reviews: Array<{ author: string; state: string; body: string; submittedAt: string }>;
}

interface RawPrView {
  number: number;
  url: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  reviews: Array<{ author: { login: string }; state: string; body: string; submittedAt: string }>;
}

export function parsePrView(json: string): PrView {
  const raw = JSON.parse(json) as RawPrView;
  return {
    number: raw.number,
    url: raw.url,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    headRefOid: raw.headRefOid,
    reviews: raw.reviews.map((r) => ({
      author: r.author.login,
      state: r.state,
      body: r.body,
      submittedAt: r.submittedAt,
    })),
  };
}

const PR_VIEW_FIELDS = "number,url,baseRefName,headRefName,headRefOid,reviews";

export async function viewPr(opts: { cwd: string }): Promise<PrView> {
  const { stdout } = await run("gh", ["pr", "view", "--json", PR_VIEW_FIELDS], { cwd: opts.cwd });
  return parsePrView(stdout);
}

export type PublishReviewResult =
  | { ok: true; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" }
  | { ok: false; error: string };

const EVENT_FLAG: Record<"APPROVE" | "REQUEST_CHANGES" | "COMMENT", string> = {
  APPROVE: "--approve",
  REQUEST_CHANGES: "--request-changes",
  COMMENT: "--comment",
};

/**
 * Publishes a PR review via `gh pr review --body-file` (never shell-interpolates the
 * body). If GitHub rejects APPROVE/REQUEST_CHANGES because the configured identity
 * authored the PR, retries once as a comment review — same content, different event type.
 */
export async function publishReview(opts: {
  cwd: string;
  prNumber: number;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  bodyFilePath: string;
}): Promise<PublishReviewResult> {
  const attempt = async (event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT") => {
    await run(
      "gh",
      ["pr", "review", String(opts.prNumber), EVENT_FLAG[event], "--body-file", opts.bodyFilePath],
      { cwd: opts.cwd }
    );
    return event;
  };

  try {
    const event = await attempt(opts.event);
    return { ok: true, event };
  } catch (err) {
    const message = (err as { stderr?: string; message: string }).stderr ?? (err as Error).message;
    if (opts.event !== "COMMENT" && /own pull request/i.test(message)) {
      try {
        const event = await attempt("COMMENT");
        return { ok: true, event };
      } catch (err2) {
        return { ok: false, error: (err2 as Error).message };
      }
    }
    return { ok: false, error: message };
  }
}
