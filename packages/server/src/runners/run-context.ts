import type { ArtifactKind, Run, StreamTraceEntry } from "@agent-dealer/shared";
import { getLatestArtifact, getLineageParentRun } from "../repository/runs.js";

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

export interface PlanRetryContext {
  feedback: string;
  priorPlan: string;
  priorResult: string;
  priorDocument: string;
}

export function planRetryContext(run: Run): PlanRetryContext | null {
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

export function planTracePrefix(run: Run): StreamTraceEntry[] {
  const ctx = planRetryContext(run);
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
  const feedback = humanFeedbackText(run);
  if (!feedback) return [];
  return [{ type: "human", text: feedback }];
}

export function appendPlanRetrySections(parts: string[], ctx: PlanRetryContext): void {
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
