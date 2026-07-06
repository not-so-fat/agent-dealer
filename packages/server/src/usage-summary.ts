import type { Run, UsageContent, UsageSummary } from "@agent-dealer/shared";
import { UsageContent as UsageContentSchema } from "@agent-dealer/shared";
import { listArtifacts, listLineageRuns } from "./repository/runs.js";

function parseUsage(contentJson: string): UsageContent | null {
  try {
    return UsageContentSchema.parse(JSON.parse(contentJson));
  } catch {
    return null;
  }
}

function labelUsage(
  lineageIdx: number,
  phase: UsageContent["phase"],
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

export function buildLineageUsageSummary(run: Run): UsageSummary {
  const lineageRuns = listLineageRuns(run);
  const lines: UsageSummary["lines"] = [];

  lineageRuns.forEach((lr, lineageIdx) => {
    let planCount = 0;
    let execCount = 0;
    for (const art of listArtifacts(lr.id)) {
      if (art.kind !== "usage" || !art.contentJson) continue;
      const usage = parseUsage(art.contentJson);
      if (!usage) continue;

      if (usage.phase === "plan") planCount++;
      else execCount++;

      lines.push({
        label: labelUsage(lineageIdx, usage.phase, planCount, execCount),
        usage,
      });
    }
  });

  const total = lines.reduce(
    (acc, { usage }) => ({
      totalCostUsd: acc.totalCostUsd + (usage.totalCostUsd ?? 0),
      inputTokens: acc.inputTokens + (usage.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (usage.outputTokens ?? 0),
      durationMs: acc.durationMs + (usage.durationMs ?? 0),
    }),
    { totalCostUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 }
  );

  return { lines, total };
}
