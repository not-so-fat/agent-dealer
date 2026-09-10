import type { WorkflowEvent } from "@agent-dealer/shared";

const LABELS: Record<string, (e: WorkflowEvent) => string> = {
  "issue.created": () => "Issue created",
  "workflow.started": () => "Workflow started",
  "worker.started": (e) => `${e.actorType === "developer" ? "Developer" : e.actorType === "reviewer" ? "Reviewer" : "Worker"} started${e.round ? ` (round ${e.round})` : ""}`,
  "worker.completed": (e) => `${e.actorType === "developer" ? "Developer" : e.actorType === "reviewer" ? "Reviewer" : "Worker"} finished${e.round ? ` (round ${e.round})` : ""}`,
  "worker.failed": () => "Worker failed",
  "pull_request.opened": () => "Developer opened the PR",
  "pull_request.updated": () => "Developer updated the PR",
  "checks.completed": () => "Checks completed",
  "review.submitted": () => "Reviewer submitted a review",
  "repair.started": (e) => `Repair round ${e.round ?? "?"} started`,
  "guidance.added": () => "Guidance added",
  "human_action.requested": () => "Human action requested",
  "human_action.resolved": () => "Human action resolved",
  "final_review.requested": () => "Final review requested",
  "issue.completed": () => "Issue completed",
  "issue.closed": () => "Issue closed",
};

function describe(e: WorkflowEvent): string {
  return LABELS[e.type]?.(e) ?? e.type;
}

export default function IssueTimeline({ events }: { events: WorkflowEvent[] }) {
  if (events.length === 0) return <p className="text-white/40 text-sm">No activity yet.</p>;
  return (
    <div className="space-y-1">
      {events.map((e) => (
        <div key={e.id} className="flex items-baseline gap-3 py-1.5 border-b border-white/5 last:border-0">
          <span className="text-xs text-white/35 w-20 shrink-0 tabular-nums">{new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          <span className="text-sm text-white/80">{describe(e)}</span>
          {e.type === "guidance.added" && e.payloadJson && (
            <span className="text-sm text-white/55 italic">
              — {(JSON.parse(e.payloadJson) as { markdown?: string }).markdown}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
