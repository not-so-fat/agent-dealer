import type { StreamTraceContent, UsageContent, UsageSummary } from "@agent-dealer/shared";
import { formatDurationMs } from "../../lib/display";

export function TracePanel({ trace, label }: { trace: StreamTraceContent | null; label?: string }) {
  if (!trace?.entries?.length) return null;
  return (
    <section className="space-y-2">
      <div className="heading-section">{label ?? "Reasoning trace"}</div>
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

function formatUsageParts(usage: UsageContent): string {
  return [
    usage.model && `model ${usage.model}`,
    usage.totalCostUsd != null && `$${usage.totalCostUsd.toFixed(4)}`,
    usage.inputTokens != null && `${usage.inputTokens} in`,
    usage.outputTokens != null && `${usage.outputTokens} out`,
    usage.durationMs != null && formatDurationMs(usage.durationMs),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function UsagePanel({ summary }: { summary: UsageSummary | null }) {
  if (!summary?.lines.length) return null;

  const showTotal = summary.lines.length > 1;

  return (
    <section className="space-y-1.5">
      <div className="heading-section">Usage</div>
      {summary.lines.map((line, i) => (
        <p key={i} className="text-sm text-white/50 font-mono">
          <span className="text-white/65">{line.label}:</span> {formatUsageParts(line.usage)}
        </p>
      ))}
      {showTotal && (
        <p className="text-sm text-[#92E4DD]/85 font-mono pt-1 border-t border-white/10">
          <span className="text-white/65">total:</span>{" "}
          {[
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
    },
  };
}
