// packages/server/src/coordinator/resume-live-head.ts
//
// NOT-226: a reviewer-origin infra escalation pins `resumeHeadSha` when the issue parks.
// An operator may then push a fix to the PR branch while it is parked — resuming must
// re-review the PR's LIVE head, not the stale pinned commit. This module owns that one
// lookup: the same `gh pr view` head (`prView.headRefOid`) the reviewer itself uses to
// detect a stale review (reviewer-effect.ts), bounded so a hung `gh` never blocks Resume.
//
// A failed lookup (no PR, missing clone, `gh` error, timeout) returns null and the
// caller keeps today's behavior (queue at the pinned head).

import { createGithubAdapter } from "../adapters/github.js";
import { classifyIssueRepo } from "../adapters/managed-repo.js";

/** Bound the live-head read so a hung `gh` degrades to "unknown", never a stuck Resume. */
export const RESUME_LIVE_HEAD_TIMEOUT_MS = 10_000;

export interface ResumeLiveHeadIssue {
  prNumber: number | null;
  repo: string;
}

/** Injectable for tests, mirroring `setMergePrForTests`. May throw — callers treat it as null. */
export type ResumeLiveHeadReader = (issue: ResumeLiveHeadIssue) => Promise<string | null>;

let readerForTests: ResumeLiveHeadReader | null = null;

export function setResumeLiveHeadReaderForTests(reader: ResumeLiveHeadReader | null): void {
  readerForTests = reader;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("resume live-head lookup timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function defaultReader(issue: ResumeLiveHeadIssue): Promise<string | null> {
  if (issue.prNumber == null) return null;
  // NOT-151: issue.repo is a portable identity, never a cwd — resolve the managed clone first.
  const cwd = classifyIssueRepo(issue.repo).repoPath;
  const view = await createGithubAdapter().viewPr({ cwd, number: issue.prNumber });
  return view?.headRefOid ?? null;
}

/**
 * The PR's live head SHA, or null when unknown (no PR, lookup error, timeout, empty).
 * Never throws — a failed lookup must never block Resume.
 */
export async function fetchResumeLiveHeadSha(issue: ResumeLiveHeadIssue): Promise<string | null> {
  try {
    if (issue.prNumber == null) return null;
    const reader = readerForTests ?? defaultReader;
    const sha = await withTimeout(reader(issue), RESUME_LIVE_HEAD_TIMEOUT_MS);
    return typeof sha === "string" && sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}
