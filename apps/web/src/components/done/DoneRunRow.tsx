import type { Run } from "@agent-dealer/shared";
import {
  categoryLabel,
  deckLabel,
  formatRelativeTime,
  runtimeLabel,
  runtimeTone,
  sourceLabel,
} from "../../lib/display";
import Badge from "../ui/Badge";
import { AgentRuntimeLogo } from "../agents/AgentIcon";

type Props = {
  run: Run;
  selected?: boolean;
  onSelect: () => void;
};

/** Wide audit row — source, title, agent, meta, time on one line. */
export default function DoneRunRow({ run, selected, onSelect }: Props) {
  const deck = deckLabel(run);
  const ts = run.updatedAt;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`task-card w-full text-left rounded-xl border-l-[3px] border-l-emerald-400/60 transition-colors ${
        selected ? "glass-plate-selected" : ""
      }`}
    >
      <div className="grid grid-cols-1 md:grid-cols-[7rem_minmax(0,1fr)_8rem_6rem_7rem_5rem] gap-x-4 gap-y-1.5 items-center px-4 py-3">
        <div className="flex items-center gap-1.5 md:contents">
          <Badge
            className={
              run.source === "linear"
                ? "bg-[#5E6AD2]/15 text-[#AEB4FF] border-[#5E6AD2]/35 shrink-0 w-fit"
                : "bg-white/5 text-white/55 border-white/15 shrink-0 w-fit"
            }
          >
            {sourceLabel(run)}
          </Badge>
          <time
            className="text-xs text-white/40 tabular-nums md:hidden ml-auto shrink-0"
            title={new Date(ts).toLocaleString()}
          >
            {formatRelativeTime(ts)}
          </time>
        </div>

        <div className="min-w-0 md:col-start-2">
          <p className="font-semibold text-[#E8F6F4] leading-snug truncate" title={run.title}>
            {run.title}
          </p>
          {run.description && (
            <p className="text-xs text-white/40 truncate mt-0.5" title={run.description}>
              {run.description}
            </p>
          )}
        </div>

        <div className="hidden md:flex items-center min-w-0">
          <Badge className={`${runtimeTone(run.runtime)} normal-case truncate max-w-full`} title={run.agentName ?? runtimeLabel(run.runtime)}>
            {run.runtime && <AgentRuntimeLogo runtime={run.runtime} className="h-3 w-3" />}
            <span className="truncate">{run.agentName ?? runtimeLabel(run.runtime)}</span>
          </Badge>
        </div>

        <span className="hidden md:block text-xs text-white/45 uppercase tracking-wide">
          {categoryLabel(run.taskCategory)}
        </span>

        <span className="hidden md:block text-xs text-[#92E4DD]/80 truncate" title={deck ?? undefined}>
          {deck ? `◆ ${deck}` : "—"}
        </span>

        <time
          className="hidden md:block text-xs text-white/40 tabular-nums text-right"
          title={new Date(ts).toLocaleString()}
        >
          {formatRelativeTime(ts)}
        </time>
      </div>
    </button>
  );
}
