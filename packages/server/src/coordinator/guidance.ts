// packages/server/src/coordinator/guidance.ts
//
// NOT-64 "guidance semantics": a one-shot developer/reviewer CLI process never inherits a
// running session (see design doc "Guidance semantics" — every round is a fresh process
// with a fresh worktree, and resuming a session across a possibly multi-day human-review
// gap is not a contract these worktree/CLI lifecycles support). So "guidance applies to
// the next worker" just means: which guidance.added text hasn't been shown to any prompt
// yet. That's everything added after the issue's previous worker session started — a
// session created while another is actively running naturally lands after that running
// session's created_at, so it's correctly deferred to the one after it, never injected
// into an already-spawned process.
import { listWorkerSessionsForIssue } from "../repository/worker-sessions.js";
import { listGuidanceMarkdownForIssue } from "../repository/workflow-events.js";

export function guidanceForNextSession(issueId: string, currentSessionId: string): string[] {
  const sessions = listWorkerSessionsForIssue(issueId);
  const idx = sessions.findIndex((s) => s.id === currentSessionId);
  const previous = idx > 0 ? sessions[idx - 1] : null;
  return listGuidanceMarkdownForIssue(issueId, previous?.createdAt ?? null);
}
