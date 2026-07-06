import type { StreamTraceContent, UsageContent } from "@agent-dealer/shared";
import { formatDurationMs } from "../../lib/display";

export function TracePanel({ trace, label }: { trace: StreamTraceContent | null; label?: string }) {
  if (!trace?.entries?.length) return null;
  return (
    <section className="space-y-2">
      <div className="heading-section">{label ?? `Reasoning Trace (${trace.phase})`}</div>
      <div className="space-y-1 max-h-48 overflow-y-auto border border-white/10 rounded p-2 bg-black/20">
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
            <div className="text-white/70 whitespace-pre-wrap mt-0.5">
              {(e.type === "human" || e.type === "context" ? e.text : e.text.slice(0, 400))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function UsagePanel({ usage }: { usage: UsageContent | null }) {
  if (!usage) return null;
  const parts = [
    usage.model && `model ${usage.model}`,
    usage.totalCostUsd != null && `$${usage.totalCostUsd.toFixed(4)}`,
    usage.inputTokens != null && `${usage.inputTokens} in`,
    usage.outputTokens != null && `${usage.outputTokens} out`,
    usage.durationMs != null && formatDurationMs(usage.durationMs),
  ].filter(Boolean);
  return (
    <p className="text-sm text-white/50">
      Usage ({usage.phase}): {parts.join(" · ")}
    </p>
  );
}
