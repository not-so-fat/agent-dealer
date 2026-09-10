import type { Issue, IssueStatus } from "@agent-dealer/shared";

export interface IntentForecast {
  now: string;
  next: string;
}

const FORECASTS: Record<IssueStatus, (issue: Issue) => IntentForecast> = {
  ready: () => ({ now: "Ready to start", next: "Start the developer round" }),
  developing: (i) => ({ now: `Developer implementing round ${i.currentRound}`, next: "Verify the handoff once the session completes" }),
  reviewing: (i) => ({ now: `Reviewer evaluating round ${i.currentRound}`, next: "Route the reviewer's verdict" }),
  repairing: (i) => ({ now: `Developer repairing round ${i.currentRound}`, next: "Verify the handoff once the session completes" }),
  final_review: () => ({ now: "Awaiting final human review", next: "Human resolves: complete, repair, or close" }),
  needs_human: () => ({ now: "Waiting on a human action", next: "Resolve the open action to resume" }),
  done: () => ({ now: "Done", next: "" }),
  closed: () => ({ now: "Closed", next: "" }),
};

export function computeIntentForecast(issue: Issue): IntentForecast {
  return FORECASTS[issue.status](issue);
}
