import type { Run } from "@agent-dealer/shared";
import {
  categoryLabel,
  deckLabel,
  formatRelativeTime,
  runtimeLabel,
  runtimeTone,
  sourceLabel,
  statusMeta,
} from "../lib/display";
import Badge from "./ui/Badge";
import { AgentRuntimeLogo } from "./agents/AgentIcon";

export type RunCardProps = {
  run: Run;
  selected?: boolean;
  onSelect: () => void;
  /** Override status chip (e.g. "plan" → Drafting plan) */
  statusOverride?: Run["status"];
  /** Show updated vs created timestamp */
  timeField?: "updated" | "created";
  compact?: boolean;
  /** Execution / planning queue position badge */
  queueBadge?: "active" | "queued" | "running" | "waiting";
  queueActiveLabel?: string;
  queueQueuedLabel?: string;
  /** Hide status chip when column context already implies it */
  hideStatusBadge?: boolean;
};

export default function RunCard({
  run,
  selected,
  onSelect,
  statusOverride,
  timeField = "updated",
  compact = false,
  queueBadge,
  queueActiveLabel = "Running",
  queueQueuedLabel = "In queue",
  hideStatusBadge = false,
}: RunCardProps) {
  const status = statusOverride ?? run.status;
  const meta = statusMeta(status);
  const ts = timeField === "created" ? run.createdAt : run.updatedAt;
  const deck = deckLabel(run);

  const queueTone =
    queueBadge === "active" || queueBadge === "running"
      ? "bg-[#92E4DD]/15 text-[#92E4DD] border-[#92E4DD]/35"
      : queueBadge === "queued" || queueBadge === "waiting"
        ? "bg-sky-500/15 text-sky-200 border-sky-400/30"
        : null;

  const isActiveBadge = queueBadge === "active" || queueBadge === "running";

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`task-card w-full text-left rounded-xl border-l-[3px] transition-colors ${
        meta.accent
      } ${selected ? "glass-plate-selected" : ""}`}
    >
      <div className={`${compact ? "p-2.5" : "p-3"} space-y-2`}>
        {/* Row 1: source + time — Botfarm task id / Autoship issue id pattern */}
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <Badge
              className={
                run.source === "linear"
                  ? "bg-[#5E6AD2]/15 text-[#AEB4FF] border-[#5E6AD2]/35 shrink-0"
                  : "bg-white/5 text-white/55 border-white/15 shrink-0"
              }
            >
              {sourceLabel(run)}
            </Badge>
            <Badge className="bg-white/5 text-white/45 border-white/10 shrink-0 normal-case">
              {categoryLabel(run.taskCategory)}
            </Badge>
          </div>
          <time className="text-xs text-white/40 tabular-nums shrink-0" title={new Date(ts).toLocaleString()}>
            {formatRelativeTime(ts)}
          </time>
        </div>

        {/* Row 2: title — primary scan target */}
        <h3 className={`font-semibold text-[#E8F6F4] leading-snug ${compact ? "text-base line-clamp-2" : "text-lg line-clamp-2"}`}>
          {run.title}
        </h3>

        {!compact && run.description && (
          <p className="text-sm text-white/45 line-clamp-2 leading-relaxed">{run.description}</p>
        )}

        {/* Row 3: agent + status — PRD in-progress slot badges */}
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <Badge
            className={`${runtimeTone(run.runtime)} normal-case`}
            title={run.runtime ? runtimeLabel(run.runtime) : undefined}
          >
            {run.runtime && <AgentRuntimeLogo runtime={run.runtime} />}
            {run.agentName ?? runtimeLabel(run.runtime)}
          </Badge>
          {deck && (
            <Badge className="bg-[#92E4DD]/10 text-[#92E4DD] border-[#92E4DD]/25 normal-case max-w-[140px] truncate" title={deck}>
              ◆ {deck}
            </Badge>
          )}
          {queueBadge ? (
            <Badge className={`${queueTone} ml-auto`}>
              {isActiveBadge && (
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#92E4DD] animate-pulse mr-0.5" />
              )}
              {isActiveBadge ? queueActiveLabel : queueQueuedLabel}
            </Badge>
          ) : !hideStatusBadge ? (
            <Badge className={`${meta.tone} ml-auto`} title={meta.hint}>
              {meta.label}
            </Badge>
          ) : null}
        </div>
      </div>
    </button>
  );
}
