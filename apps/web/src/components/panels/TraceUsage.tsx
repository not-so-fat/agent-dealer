import type { ReactNode } from "react";
import type { StreamTraceContent, UsageContent, UsageLineItem, UsageSummary } from "@agent-dealer/shared";
import { formatDurationMs } from "../../lib/display";

export function TracePanel({
  trace,
  label,
  showHeading = true,
}: {
  trace: StreamTraceContent | null;
  label?: string;
  showHeading?: boolean;
}) {
  if (!trace?.entries?.length) return null;
  return (
    <section className="space-y-2">
      {showHeading && <div className="heading-section">{label ?? "Reasoning trace"}</div>}
      <div className="space-y-1 max-h-72 overflow-y-auto border border-white/10 rounded p-2 bg-black/20">
        {trace.entries.map((e, i) => (
          <div key={i} className="text-sm font-mono">
            <span
              className={
                e.type === "human"
                  ? "text-[#C4B643]"
                  : e.type === "context"
                    ? "text-white/50"
                    : "text-[#92E4DD]"
              }
            >
              {e.type}
            </span>
            {e.toolName && <span className="text-white/40"> · {e.toolName}</span>}
            <div className="text-white/70 whitespace-pre-wrap mt-0.5">{e.text}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function atCap(used: number, max?: number): boolean {
  return max != null && used >= max;
}

function TurnLine({ used, max }: { used: number; max?: number }) {
  const hit = atCap(used, max);
  const text =
    max != null
      ? `${used} / ${max} turn${max === 1 ? "" : "s"}`
      : `${used} turn${used === 1 ? "" : "s"}`;
  return <span className={hit ? "text-red-400 font-bold" : undefined}>{text}</span>;
}

function CostLine({ used, max }: { used: number; max?: number }) {
  const hit = atCap(used, max);
  const text = max != null ? `$${used.toFixed(4)} / $${max.toFixed(2)}` : `$${used.toFixed(4)}`;
  return <span className={hit ? "text-red-400 font-bold" : undefined}>{text}</span>;
}

function UsageLineParts({ line }: { line: UsageLineItem }) {
  const { usage, maxTurns, maxBudgetUsd } = line;
  const parts: ReactNode[] = [];

  if (usage.model) parts.push(`model ${usage.model}`);
  if (usage.numTurns != null) parts.push(<TurnLine key="turns" used={usage.numTurns} max={maxTurns} />);
  if (usage.totalCostUsd != null) {
    parts.push(<CostLine key="usd" used={usage.totalCostUsd} max={maxBudgetUsd} />);
  }
  if (usage.inputTokens != null) parts.push(`${usage.inputTokens} in`);
  if (usage.outputTokens != null) parts.push(`${usage.outputTokens} out`);
  if (usage.durationMs != null) parts.push(formatDurationMs(usage.durationMs));

  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && " · "}
          {part}
        </span>
      ))}
    </>
  );
}

export function UsagePanel({ summary }: { summary: UsageSummary | null }) {
  if (!summary?.lines.length) return null;

  const showTotal = summary.lines.length > 1;

  return (
    <section className="space-y-1.5">
      <div className="heading-section">Usage</div>
      {summary.lines.map((line, i) => (
        <p key={i} className="text-sm text-white/50 font-mono">
          <span className="text-white/65">{line.label}:</span> <UsageLineParts line={line} />
        </p>
      ))}
      {showTotal && (
        <p className="text-sm text-[#92E4DD]/85 font-mono pt-1 border-t border-white/10">
          <span className="text-white/65">total:</span>{" "}
          {[
            summary.total.numTurns > 0 && `${summary.total.numTurns} turn${summary.total.numTurns === 1 ? "" : "s"}`,
            summary.total.totalCostUsd > 0 && `$${summary.total.totalCostUsd.toFixed(4)}`,
            summary.total.inputTokens > 0 && `${summary.total.inputTokens} in`,
            summary.total.outputTokens > 0 && `${summary.total.outputTokens} out`,
            summary.total.durationMs > 0 && formatDurationMs(summary.total.durationMs),
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
    </section>
  );
}

/** @deprecated pass UsageSummary from fetchRunDetail */
export function usageFromSingle(usage: UsageContent | null): UsageSummary | null {
  if (!usage) return null;
  return {
    lines: [{ label: usage.phase, usage }],
    total: {
      totalCostUsd: usage.totalCostUsd ?? 0,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      durationMs: usage.durationMs ?? 0,
      numTurns: usage.numTurns ?? 0,
    },
  };
}
