import type { WorkflowEvent } from "@agent-dealer/shared";

function roleNoun(actorType: WorkflowEvent["actorType"]): string {
  if (actorType === "developer") return "Developer";
  if (actorType === "reviewer") return "Reviewer";
  return "Worker";
}

const LABELS: Record<string, (e: WorkflowEvent) => string> = {
  "issue.created": () => "Issue created",
  "workflow.started": () => "Workflow started",
  "worker.started": (e) => `${roleNoun(e.actorType)} started${e.round ? ` (round ${e.round})` : ""}`,
  "worker.completed": (e) => `${roleNoun(e.actorType)} finished${e.round ? ` (round ${e.round})` : ""}`,
  "worker.failed": (e) => `${roleNoun(e.actorType)} failed${e.round ? ` (round ${e.round})` : ""}`,
  // NOT-136: a deck outage is not a worker problem — say what is actually being waited on.
  "worker.deferred": (e) =>
    parseJson<{ outcome?: string }>(e.payloadJson)?.outcome === "deck_unavailable"
      ? `Waiting for Agent Deck${e.round ? ` (round ${e.round})` : ""}`
      : `${roleNoun(e.actorType)} deferred${e.round ? ` (round ${e.round})` : ""}`,
  "worktree.ready": () => "Worktree ready",
  "deck.connected": () => "Deck connected",
  "brief.resolved": () => "Brief resolved",
  "branch.pushed": () => "Branch pushed",
  "checks.started": () => "Checks started",
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
  if (
    e.type === "worker.started" ||
    e.type === "worker.completed" ||
    e.type === "worker.failed" ||
    e.type === "worker.deferred" ||
    e.type === "worktree.ready" ||
    e.type === "deck.connected" ||
    e.type === "brief.resolved" ||
    e.type === "branch.pushed" ||
    e.type === "checks.started" ||
    e.type === "checks.completed"
  ) {
    const payload = parseJson<{
      runtime?: string | null;
      model?: string | null;
      sessionId?: string;
      worktreePath?: string | null;
      resolution?: string;
      snapshot?: string;
      commitsAhead?: number;
      branch?: string;
      reason?: string;
      until?: string;
    }>(e.payloadJson);
    if (!payload) return null;
    const bits: string[] = [];
    if (payload.runtime) bits.push(payload.runtime);
    if (payload.model) bits.push(payload.model);
    if (payload.sessionId) bits.push(payload.sessionId.slice(0, 8));
    if (payload.worktreePath) bits.push(payload.worktreePath);
    if (payload.resolution) bits.push(payload.resolution);
    if (payload.branch) bits.push(payload.branch);
    if (payload.commitsAhead != null) bits.push(`${payload.commitsAhead} ahead`);
    if (payload.snapshot) bits.push(payload.snapshot);
    if (e.type === "worker.deferred" || e.type === "worker.failed") {
      if (payload.reason) bits.push(payload.reason);
      if (e.type === "worker.deferred" && payload.until) {
        bits.push(`until ${new Date(payload.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
      }
    }
    if (bits.length === 0) return null;
    return <span className="text-xs text-white/40">· {bits.join(" · ")}</span>;
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
