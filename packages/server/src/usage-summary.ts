import type { Run, UsageContent, UsageSummary, Artifact } from "@agent-dealer/shared";
import { UsageContent as UsageContentSchema } from "@agent-dealer/shared";
import { listArtifacts, listLineageRuns, resolveBudgetForPhase } from "./repository/runs.js";

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
  execCount: number,
  qaCount: number
): string {
  if (phase === "plan") {
    return planCount > 1 ? `plan ${planCount}` : "plan";
  }
  if (phase === "qa") {
    return qaCount > 1 ? `Q&A ${qaCount}` : "Q&A";
  }
  if (lineageIdx === 0) {
    return execCount > 1 ? `execute ${execCount}` : "execute";
  }
  return lineageIdx === 1 ? "retry" : `retry ${lineageIdx}`;
}

export function buildLineageUsageSummary(
  run: Run,
  opts?: { artifactsByRunId?: Record<string, Artifact[]> }
): UsageSummary {
  const lineageRuns = listLineageRuns(run);
  const lines: UsageSummary["lines"] = [];

  lineageRuns.forEach((lr, lineageIdx) => {
    let planCount = 0;
    let execCount = 0;
    let qaCount = 0;
    const arts = opts?.artifactsByRunId?.[lr.id] ?? listArtifacts(lr.id);
    for (const art of arts) {
      if (art.kind !== "usage" || !art.contentJson) continue;
      const usage = parseUsage(art.contentJson);
      if (!usage) continue;

      if (usage.phase === "plan") planCount++;
      else if (usage.phase === "qa") qaCount++;
      else execCount++;

      // qa has no configurable budget — its cap is snapshotted on the artifact
      const resolved = usage.phase === "qa" ? null : resolveBudgetForPhase(lr, usage.phase);

      lines.push({
        label: labelUsage(lineageIdx, usage.phase, planCount, execCount, qaCount),
        usage,
        maxTurns: usage.maxTurns ?? resolved?.maxTurns,
        maxBudgetUsd: usage.maxBudgetUsd ?? resolved?.maxBudgetUsd,
      });
    }
  });

  const total = lines.reduce(
    (acc, { usage }) => ({
      totalCostUsd: acc.totalCostUsd + (usage.totalCostUsd ?? 0),
      inputTokens: acc.inputTokens + (usage.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (usage.outputTokens ?? 0),
      durationMs: acc.durationMs + (usage.durationMs ?? 0),
      numTurns: acc.numTurns + (usage.numTurns ?? 0),
    }),
    { totalCostUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, numTurns: 0 }
  );

  return { lines, total };
}
