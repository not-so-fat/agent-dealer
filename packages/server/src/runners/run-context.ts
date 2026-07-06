import type { ArtifactKind, Run, StreamTraceContent, StreamTraceEntry } from "@agent-dealer/shared";
import { getLatestArtifact, getLineageParentRun, listArtifacts } from "../repository/runs.js";

const EXCERPT = 2000;

function artifactMarkdown(runId: string, kind: ArtifactKind): string {
  const art = getLatestArtifact(runId, kind);
  if (!art?.contentJson) return "";
  try {
    const parsed = JSON.parse(art.contentJson) as {
      markdown?: string;
      resultText?: string;
    };
    return parsed.markdown?.trim() ?? parsed.resultText?.trim() ?? "";
  } catch {
    return "";
  }
}

export function humanFeedbackText(run: Run): string {
  const fb = getLatestArtifact(run.id, "feedback");
  if (!fb?.contentJson || fb.author !== "human") return "";
  try {
    const parsed = JSON.parse(fb.contentJson) as { markdown?: string };
    return parsed.markdown?.trim() ?? "";
  } catch {
    return "";
  }
}

function excerpt(text: string, max = EXCERPT): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

export interface RetryContext {
  feedback: string;
  priorPlan: string;
  priorResult: string;
  priorDocument: string;
}

export function retryContext(run: Run): RetryContext | null {
  const feedback = humanFeedbackText(run);
  const parent = getLineageParentRun(run);
  if (!feedback && !parent) return null;

  const parentId = parent?.id;
  return {
    feedback,
    priorPlan: parentId ? artifactMarkdown(parentId, "approved_plan") || artifactMarkdown(parentId, "draft_plan") : "",
    priorResult: parentId ? artifactMarkdown(parentId, "execution_result") : "",
    priorDocument: parentId ? artifactMarkdown(parentId, "document") : "",
  };
}

/** @deprecated use retryContext */
export const planRetryContext = retryContext;

export function lineageParentExecuteSessionId(run: Run): string | null {
  const parent = getLineageParentRun(run);
  if (!parent) return null;

  const sessions = listArtifacts(parent.id).filter((a) => a.kind === "agent_session");
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (!sessions[i].contentJson) continue;
    try {
      const parsed = JSON.parse(sessions[i].contentJson!) as { phase?: string; sessionId?: string };
      if (parsed.phase === "execute" && parsed.sessionId) return parsed.sessionId;
    } catch {
      /* skip */
    }
  }
  return null;
}

function priorExecuteTraceTail(run: Run, max = 12): StreamTraceEntry[] {
  const parent = getLineageParentRun(run);
  if (!parent) return [];

  const art = getLatestArtifact(parent.id, "stream_trace");
  if (!art?.contentJson) return [];
  try {
    const parsed = JSON.parse(art.contentJson) as StreamTraceContent;
    if (parsed.phase !== "execute") return [];
    return parsed.entries.slice(-max).map((e) => ({
      type: "context" as const,
      text: `[prior · ${e.type}] ${excerpt(e.text, 500)}`,
    }));
  } catch {
    return [];
  }
}

export function planTracePrefix(run: Run): StreamTraceEntry[] {
  const ctx = retryContext(run);
  if (!ctx) return [];

  const entries: StreamTraceEntry[] = [];
  if (ctx.feedback) {
    entries.push({ type: "human", text: ctx.feedback });
  }
  if (ctx.priorResult) {
    entries.push({
      type: "context",
      text: `Previous execution outcome:\n${excerpt(ctx.priorResult, 800)}`,
    });
  }
  if (ctx.priorPlan) {
    entries.push({
      type: "context",
      text: `Previous plan:\n${excerpt(ctx.priorPlan, 800)}`,
    });
  }
  return entries;
}

export function executeTracePrefix(run: Run): StreamTraceEntry[] {
  const ctx = retryContext(run);
  if (!ctx) return [];

  const entries: StreamTraceEntry[] = [];
  if (ctx.feedback) {
    entries.push({ type: "human", text: ctx.feedback });
  }
  if (ctx.priorDocument) {
    entries.push({
      type: "context",
      text: `Prior deliverable:\n${excerpt(ctx.priorDocument, 1200)}`,
    });
  }
  if (ctx.priorResult) {
    entries.push({
      type: "context",
      text: `Prior execution outcome:\n${excerpt(ctx.priorResult, 800)}`,
    });
  }

  const tail = priorExecuteTraceTail(run);
  if (tail.length) {
    entries.push({ type: "context", text: "── prior attempt trace ──" });
    entries.push(...tail);
  }
  if (entries.length) {
    entries.push({ type: "context", text: "── retry attempt ──" });
  }
  return entries;
}

export function appendPlanRetrySections(parts: string[], ctx: RetryContext): void {
  parts.push(
    `This is a retry — revise the plan using the human feedback and prior attempt below.`,
    ``
  );

  if (ctx.feedback) {
    parts.push(`## Human feedback (apply first)`, ctx.feedback, ``);
  }
  if (ctx.priorPlan) {
    parts.push(`## Previous plan`, excerpt(ctx.priorPlan), ``);
  }
  if (ctx.priorResult) {
    parts.push(`## Previous execution outcome`, excerpt(ctx.priorResult), ``);
  }
  if (ctx.priorDocument) {
    parts.push(`## Previous deliverable (excerpt)`, excerpt(ctx.priorDocument), ``);
  }
}

export function appendExecutionRetrySections(parts: string[], ctx: RetryContext): void {
  parts.push(
    `This is an execution retry — continue from the prior attempt. Do NOT restart from scratch.`,
    `Read existing outputs and build on completed work unless feedback requires redoing a step.`,
    ``
  );

  if (ctx.feedback) {
    parts.push(`## Human feedback (apply first)`, ctx.feedback, ``);
  }
  if (ctx.priorDocument) {
    parts.push(`## Prior deliverable (update in place where possible)`, excerpt(ctx.priorDocument, 3000), ``);
  }
  if (ctx.priorResult) {
    parts.push(`## Prior execution outcome`, excerpt(ctx.priorResult), ``);
  }
  if (ctx.priorPlan) {
    parts.push(`## Approved plan (unchanged)`, excerpt(ctx.priorPlan, 1500), ``);
  }
}
