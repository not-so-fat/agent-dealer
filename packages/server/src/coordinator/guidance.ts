// packages/server/src/coordinator/guidance.ts
//
// NOT-64 "guidance semantics": a one-shot developer/reviewer CLI process never inherits a
// running session (see design doc "Guidance semantics" — every round is a fresh process
// with a fresh worktree, and resuming a session across a possibly multi-day human-review
// gap is not a contract these worktree/CLI lifecycles support). So "guidance applies to
// the next worker" just means: which guidance.added text hasn't been shown to any prompt
// yet. That's everything added after the issue's previous worker session's own snapshot
// moment, up through THIS session's own snapshot moment.
//
// The upper bound matters: worker-loop.ts marks a session "running" (startSession, setting
// startedAt) *before* the effect handler's worktree setup and deck bind — both of which
// take real wall-clock time before this function is actually called to build the prompt.
// Guidance posted during that setup window arrives after the session is already dispatched
// and (per the UI contract) must be deferred to the *next* worker, not swept into this one
// just because the query ran a few seconds late. Anchoring "until" to the current session's
// own startedAt (falling back to createdAt if it hasn't started yet) makes the window exact
// regardless of when this function happens to be invoked.
import { listWorkerSessionsForIssue } from "../repository/worker-sessions.js";
import { listGuidanceMarkdownForIssue } from "../repository/workflow-events.js";

export function guidanceForNextSession(issueId: string, currentSessionId: string): string[] {
  const sessions = listWorkerSessionsForIssue(issueId);
  const idx = sessions.findIndex((s) => s.id === currentSessionId);
  const current = idx >= 0 ? sessions[idx] : null;
  const previous = idx > 0 ? sessions[idx - 1] : null;
  const until = current?.startedAt ?? current?.createdAt ?? null;
  return listGuidanceMarkdownForIssue(issueId, previous?.createdAt ?? null, until);
}
