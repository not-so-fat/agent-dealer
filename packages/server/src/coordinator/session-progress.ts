// packages/server/src/coordinator/session-progress.ts
//
// NOT-109: low-volume mid-session milestones + live intent updates so Issue Detail answers
// "what happened last?" while a developer/reviewer is running. Timeline events are
// milestones only — never per-tool-call. During a long agent spawn, a log sampler may
// refresh `currentIntent` without appending events.
import fs from "node:fs";
import type { WorkflowEventType } from "@agent-dealer/shared";
import { getIssue, transitionIssue } from "../repository/issues.js";
import { appendWorkflowEvent } from "../repository/workflow-events.js";
import { parseNdjson } from "../runners/stream-json.js";

export type SessionRole = "developer" | "reviewer";

const ROLE_LABEL: Record<SessionRole, string> = {
  developer: "Developer",
  reviewer: "Reviewer",
};

const LIVE_STATUSES = new Set(["developing", "reviewing", "repairing"]);

/** Short worktree path for timeline payloads — last two path segments when present. */
export function shortWorktreePath(worktreePath: string | null | undefined): string | null {
  if (!worktreePath) return null;
  const parts = worktreePath.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return worktreePath;
  return parts.slice(-2).join("/");
}

export interface WorkerSessionPayload {
  runtime: string | null;
  model: string | null;
  sessionId: string;
  worktreePath?: string | null;
}

export function workerSessionPayload(input: {
  runtime: string | null | undefined;
  model: string | null | undefined;
  sessionId: string;
  worktreePath?: string | null;
}): WorkerSessionPayload {
  return {
    runtime: input.runtime ?? null,
    model: input.model ?? null,
    sessionId: input.sessionId,
    ...(input.worktreePath !== undefined
      ? { worktreePath: shortWorktreePath(input.worktreePath) }
      : {}),
  };
}

/** Updates currentIntent in place (status self-loop) while a session is live. */
export function setLiveIntent(issueId: string, intent: string): void {
  const issue = getIssue(issueId);
  if (!issue || !LIVE_STATUSES.has(issue.status)) return;
  if (issue.currentIntent === intent) return;
  transitionIssue(issueId, issue.status, { currentIntent: intent });
}

export interface EmitMilestoneInput {
  issueId: string;
  workflowInstanceId: string;
  workerSessionId: string;
  role: SessionRole;
  stage: string;
  round: number;
  type: WorkflowEventType;
  intent: string;
  payload?: unknown;
}

/**
 * Append a milestone timeline event and refresh the issue's primary status line.
 * Callers must keep volume low — setup / checks / push, not every tool use.
 */
export function emitSessionMilestone(input: EmitMilestoneInput): void {
  appendWorkflowEvent({
    issueId: input.issueId,
    workflowInstanceId: input.workflowInstanceId,
    workerSessionId: input.workerSessionId,
    type: input.type,
    actorType: input.role,
    stage: input.stage,
    round: input.round,
    payload: input.payload,
  });
  setLiveIntent(input.issueId, input.intent);
}

const ACTIVITY_RULES: Array<{ match: RegExp; label: string }> = [
  { match: /lens|bugbot|security-review/i, label: "Lens check" },
  { match: /pytest|npm test|vitest|jest|node --test|flow:verify|typecheck/i, label: "running tests" },
  { match: /git commit|gh pr|commit/i, label: "committing" },
  { match: /write|stredit|applypatch|editnotebook|search_replace/i, label: "editing" },
  { match: /shell|bash|terminal/i, label: "running commands" },
  { match: /call_service_tool|get_issue|linear/i, label: "fetching ticket brief" },
  { match: /bind_workspace|get_bound_deck|get_playbook/i, label: "deck bind" },
  { match: /read|grep|glob|semanticsearch/i, label: "exploring code" },
];

function toolNameFromEvent(e: Record<string, unknown>): string | null {
  if (e.type === "tool_call") {
    const name = (e as { name?: string; tool_name?: string }).name ?? (e as { tool_name?: string }).tool_name;
    return typeof name === "string" ? name : null;
  }
  if (e.type === "assistant") {
    const msg = e.message as { content?: Array<{ type?: string; name?: string }> } | undefined;
    const tool = msg?.content?.find((c) => c.type === "tool_use" && c.name);
    return tool?.name ?? null;
  }
  // cursor / other runtimes sometimes nest tool metadata differently
  if (typeof e.tool_name === "string") return e.tool_name;
  if (typeof e.name === "string" && (e.type === "tool" || e.type === "function_call")) return e.name;
  return null;
}

/**
 * Derive a short operator-facing activity line from the latest tool-ish log events.
 * Returns null when the log has nothing actionable yet.
 */
export function deriveActivityFromLog(logPath: string): string | null {
  if (!logPath || !fs.existsSync(logPath)) return null;
  let raw: string;
  try {
    // Tail only — mid-session logs can be large; last ~64KiB is enough for recent tools.
    const size = fs.statSync(logPath).size;
    const start = Math.max(0, size - 64_000);
    const fd = fs.openSync(logPath, "r");
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      raw = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const events = parseNdjson(raw);
  for (let i = events.length - 1; i >= 0; i--) {
    const name = toolNameFromEvent(events[i]!);
    if (!name) continue;
    for (const rule of ACTIVITY_RULES) {
      if (rule.match.test(name) || rule.match.test(JSON.stringify(events[i]).slice(0, 500))) {
        return rule.label;
      }
    }
    return `using ${name}`;
  }
  return null;
}

/**
 * While an agent CLI is running, periodically refresh currentIntent from the session log
 * without flooding the timeline. No-ops when the log has no new activity label.
 */
export function startActivitySampler(opts: {
  issueId: string;
  role: SessionRole;
  round: number;
  logPath: string;
  intervalMs?: number;
}): { stop: () => void } {
  const prefix = `${ROLE_LABEL[opts.role]} ·`;
  let lastLabel: string | null = null;
  const tick = () => {
    const activity = deriveActivityFromLog(opts.logPath);
    if (!activity || activity === lastLabel) return;
    lastLabel = activity;
    setLiveIntent(opts.issueId, `${prefix} ${activity} (round ${opts.round})`);
  };
  const handle = setInterval(tick, opts.intervalMs ?? 10_000);
  // First sample soon so the strip moves off "session running" once tools appear.
  const first = setTimeout(tick, 2_000);
  return {
    stop() {
      clearInterval(handle);
      clearTimeout(first);
    },
  };
}

/** Task/AC are "complete enough" that the agent need not fetch Linear for the brief. */
export function taskBriefIsComplete(task: { description?: string; acceptanceCriteria?: string }): boolean {
  return Boolean(task.description?.trim() && task.acceptanceCriteria?.trim());
}
