import type { Run, StreamTraceContent, StreamTraceEntry } from "@agent-dealer/shared";
import { StreamTraceContent as StreamTraceContentSchema } from "@agent-dealer/shared";
import { listArtifacts, listLineageRuns } from "./repository/runs.js";

type TimelineItem = { at: string; seq: number; entry: StreamTraceEntry };

function parseStreamTrace(contentJson: string): StreamTraceContent | null {
  try {
    return StreamTraceContentSchema.parse(JSON.parse(contentJson));
  } catch {
    return null;
  }
}

function agentOnlyEntries(entries: StreamTraceEntry[]): StreamTraceEntry[] {
  const start = entries.findIndex(
    (e) =>
      e.type === "system" ||
      e.type === "thinking" ||
      e.type === "tool" ||
      e.type === "assistant" ||
      e.type === "result" ||
      e.type === "rate_limit"
  );
  return start >= 0 ? entries.slice(start) : [];
}

function phaseLabel(
  lineageIdx: number,
  phase: StreamTraceContent["phase"],
  planCount: number,
  execCount: number
): string {
  if (phase === "plan") {
    return planCount > 1 ? `plan ${planCount}` : "plan";
  }
  if (lineageIdx === 0) {
    return execCount > 1 ? `execute ${execCount}` : "execute";
  }
  return lineageIdx === 1 ? "retry" : `retry ${lineageIdx}`;
}

function parseHumanFeedback(contentJson: string): string {
  try {
    const parsed = JSON.parse(contentJson) as { markdown?: string };
    return parsed.markdown?.trim() ?? "";
  } catch {
    return "";
  }
}

/** Chronological trace across lineage: plan → execute → retry instruction → retry → … */
export function buildLineageTraceSummary(run: Run): StreamTraceContent | null {
  const lineageRuns = listLineageRuns(run);
  const timeline: TimelineItem[] = [];
  let seq = 0;
  let runtime = run.runtime ?? undefined;

  lineageRuns.forEach((lr, lineageIdx) => {
    let planCount = 0;
    let execCount = 0;
    const hasChildRun = lineageIdx < lineageRuns.length - 1;

    for (const art of listArtifacts(lr.id)) {
      if (art.kind === "stream_trace" && art.contentJson) {
        const trace = parseStreamTrace(art.contentJson);
        if (!trace) continue;

        runtime = trace.runtime ?? runtime;
        if (trace.phase === "plan") planCount++;
        else execCount++;

        const label = phaseLabel(lineageIdx, trace.phase, planCount, execCount);
        timeline.push({
          at: art.createdAt,
          seq: seq++,
          entry: { type: "context", text: `── ${label} ──` },
        });

        for (const entry of agentOnlyEntries(trace.entries)) {
          timeline.push({ at: art.createdAt, seq: seq++, entry });
        }
      }

      if (art.kind === "feedback" && art.author === "human" && art.contentJson && hasChildRun) {
        const markdown = parseHumanFeedback(art.contentJson);
        if (!markdown) continue;
        timeline.push({
          at: art.createdAt,
          seq: seq++,
          entry: { type: "context", text: "── retry instruction ──" },
        });
        timeline.push({
          at: art.createdAt,
          seq: seq++,
          entry: { type: "human", text: markdown },
        });
      }
    }
  });

  if (!timeline.length) return null;

  timeline.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);

  return {
    phase: "execute",
    runtime: runtime ?? "claude_code",
    entries: timeline.map((t) => t.entry),
  };
}
