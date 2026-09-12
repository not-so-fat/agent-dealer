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

function parseJson<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

const VERDICT_CLASS: Record<string, string> = {
  approved: "text-cyber-teal",
  changes_requested: "text-amber-300",
  escalated: "text-red-300",
};

/** PR open/update and a submitted review are handoffs between agents, not chat — the
 * ticket calls for rendering them as linked artifacts rather than a plain text line. */
function EventBody({ e }: { e: WorkflowEvent }) {
  if (e.type === "pull_request.opened" || e.type === "pull_request.updated") {
    const payload = parseJson<{ prNumber?: number; branch?: string }>(e.payloadJson);
    if (e.artifactRef) {
      return (
        <a href={e.artifactRef} target="_blank" rel="noreferrer" className="text-sm text-cyber-teal hover:underline">
          PR {payload?.prNumber ? `#${payload.prNumber}` : ""} {payload?.branch ? `(${payload.branch})` : ""}
        </a>
      );
    }
    return null;
  }
  if (e.type === "review.submitted") {
    const result = parseJson<{ verdict: string; findings?: Array<{ severity: string }> }>(e.payloadJson);
    if (!result) return null;
    return (
      <span className="text-sm">
        <span className={VERDICT_CLASS[result.verdict] ?? "text-white/70"}>{result.verdict.replace("_", " ")}</span>
        {result.findings?.length ? ` · ${result.findings.length} finding(s)` : ""}
      </span>
    );
  }
  if (e.type === "guidance.added") {
    const payload = parseJson<{ markdown?: string }>(e.payloadJson);
    return payload?.markdown ? <span className="text-sm text-white/55 italic">— {payload.markdown}</span> : null;
  }
  return null;
}

function describe(e: WorkflowEvent): string {
  return LABELS[e.type]?.(e) ?? e.type;
}

const ACTOR_LABEL: Record<WorkflowEvent["actorType"], string> = {
  human: "You",
  system: "System",
  developer: "Developer",
  reviewer: "Reviewer",
};

const ACTOR_CLASS: Record<WorkflowEvent["actorType"], string> = {
  human: "bg-cyber-teal/15 text-cyber-teal",
  system: "bg-white/10 text-white/50",
  developer: "bg-cyber-violet/20 text-cyber-violet-light",
  reviewer: "bg-[#C4B643]/25 text-[#E8DC7A]",
};

/** Who acted: role badge, plus the agent/session ref when the coordinator recorded one. */
function actorText(e: WorkflowEvent): string {
  return e.actorRef ? `${ACTOR_LABEL[e.actorType]} · ${e.actorRef}` : ACTOR_LABEL[e.actorType];
}

export default function IssueTimeline({ events }: { events: WorkflowEvent[] }) {
  if (events.length === 0) return <p className="text-white/40 text-sm">No activity yet.</p>;
  return (
    <div className="space-y-1">
      {events.map((e) => (
        <div key={e.id} className="flex items-baseline gap-3 py-1.5 border-b border-white/5 last:border-0">
          <span className="text-xs text-white/35 w-20 shrink-0 tabular-nums">{new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          <span className={`text-[11px] leading-none px-1.5 py-0.5 rounded shrink-0 ${ACTOR_CLASS[e.actorType]}`}>{actorText(e)}</span>
          <span className="text-sm text-white/80">{describe(e)}</span>
          <EventBody e={e} />
        </div>
      ))}
    </div>
  );
}
