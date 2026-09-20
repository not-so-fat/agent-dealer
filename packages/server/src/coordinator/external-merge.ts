// packages/server/src/coordinator/external-merge.ts
//
// NOT-196: a PR merged outside Dealer leaves no trace in the DB — the issue still sits
// in a pre-merge status with only "Resume development" or "Close" offered, and Close
// parks it at `closed`, on which every dependent waits forever (blockerVerdict releases
// a Dealer-tracked blocker only on dealer `done`, deliberately ignoring Linear's Done).
//
// This module is the bounded read that closes that gap: when a close/abort resolution
// lands on an issue that has a PR number, the caller asks GitHub for that PR's state
// first. MERGED upgrades the close to `done` (landed); anything else — open,
// closed-unmerged, no PR, or unreadable — keeps today's `closed`. An unreadable state
// (gh error, timeout, unresolvable checkout) NEVER guesses `done`: it fails closed to
// `closed` and says so in the event payload.
//
// The check runs outside any DB transaction (async, like finalizeAutoMerge's `gh`
// merge) and is hard-bounded so a hung `gh` cannot stall the HTTP response behind it.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveAutoMergeCwd, GH_MERGE_TIMEOUT_MS } from "./auto-merge.js";

const run = promisify(execFile);

/**
 * What the close/abort decision needs to know about the issue's PR.
 *
 * - "merged" → the code landed outside Dealer: finish as `done`.
 * - "open" | "closed-unmerged" → today's `closed`.
 * - "unknown" → `gh` errored, timed out, or no checkout could answer: today's `closed`,
 *   with the event recording that the merge state was unknown. Never `done`.
 * - "no-pr" → the issue has no PR number at all: today's `closed`, no `gh` call.
 */
export type ExternalMergeState = "merged" | "open" | "closed-unmerged" | "unknown" | "no-pr";

/** Raw `gh pr view --json state` values. Anything unrecognized maps to "unknown". */
export function parsePrState(rawState: unknown): Exclude<ExternalMergeState, "no-pr"> {
  if (rawState === "MERGED") return "merged";
  if (rawState === "OPEN") return "open";
  if (rawState === "CLOSED") return "closed-unmerged";
  return "unknown";
}

export type PrStateReader = (opts: { cwd: string; number: number }) => Promise<unknown>;

const realPrStateReader: PrStateReader = async ({ cwd, number }) => {
  const { stdout } = await run("gh", ["pr", "view", String(number), "--json", "state"], {
    cwd,
    encoding: "utf8",
    // Reuses the merge path's bound: a hung `gh` (auth prompt, outage) fails closed
    // to "unknown" instead of holding the operator's close request hostage.
    timeout: GH_MERGE_TIMEOUT_MS,
  });
  return (JSON.parse(stdout) as { state?: unknown }).state;
};

let prStateReader: PrStateReader = realPrStateReader;

/** Test hook — inject a fake so unit tests never shell out to `gh`. */
export function setPrStateReaderForTests(fn: PrStateReader | null): void {
  prStateReader = fn ?? realPrStateReader;
}

export function resetExternalMergeForTests(): void {
  prStateReader = realPrStateReader;
}

/**
 * The pre-read for a close/abort resolution. Pure decision input: never throws — every
 * failure mode (no PR, no checkout, `gh` error/timeout, unparsable state) maps to a
 * non-"merged" state, so the caller can only reach `done` on a confirmed MERGED.
 */
export async function externalMergeStateForIssue(issue: {
  prNumber: number | null | undefined;
  repo: string;
}): Promise<ExternalMergeState> {
  if (issue.prNumber == null) return "no-pr";
  const resolvedCwd = resolveAutoMergeCwd(issue.repo);
  if (!resolvedCwd.ok) return "unknown";
  try {
    const raw = await prStateReader({ cwd: resolvedCwd.cwd, number: issue.prNumber });
    return parsePrState(raw);
  } catch {
    return "unknown";
  }
}
