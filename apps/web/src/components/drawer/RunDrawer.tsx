import { useEffect } from "react";
import type { Run } from "@agent-dealer/shared";
import {
  categoryLabel,
  deckLabel,
  formatRelativeTime,
  runtimeLabel,
  runtimeTone,
  sourceLabel,
  statusMeta,
} from "../../lib/display";
import Badge from "../ui/Badge";
import DrawerNav from "./DrawerNav";
import DoneReviewPanel from "./DoneReviewPanel";
import ExecutionPanel from "./ExecutionPanel";
import PlanReviewPanel from "./PlanReviewPanel";
import ResultReviewPanel from "./ResultReviewPanel";

type QueueNav = {
  runs: Run[];
  index: number;
  onPrev: () => void;
  onNext: () => void;
};

type Props = {
  run: Run;
  onClose: () => void;
  onRefresh: () => void;
  onApproved?: () => void;
  onApprovedAndNext?: () => void;
  onDoneAndNext?: () => void;
  onRetry?: (newRun: Run) => void;
  queueNav?: QueueNav;
};

export default function RunDrawer({
  run,
  onClose,
  onRefresh,
  onApproved,
  onApprovedAndNext,
  onDoneAndNext,
  onRetry,
  queueNav,
}: Props) {
  const meta = statusMeta(run.status);
  const deck = deckLabel(run);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (!queueNav) return;
      if (e.key === "ArrowLeft" && queueNav.index > 0) {
        e.preventDefault();
        queueNav.onPrev();
      }
      if (e.key === "ArrowRight" && queueNav.index < queueNav.runs.length - 1) {
        e.preventDefault();
        queueNav.onNext();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [queueNav, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
      <button
        type="button"
        className="absolute inset-0 bg-black/65 backdrop-blur-[2px]"
        onClick={onClose}
        aria-label="Close review"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-[min(1200px,96vw)] h-[min(92vh,960px)] panel-surface flex flex-col text-[#E8F6F4] rounded-2xl overflow-hidden"
      >
      <div className="p-4 border-b border-white/10 space-y-3 shrink-0">
        <div className="flex justify-between items-start gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge className="bg-[#5E6AD2]/15 text-[#AEB4FF] border-[#5E6AD2]/35">{sourceLabel(run)}</Badge>
              <Badge className="bg-white/5 text-white/45 border-white/10 normal-case">{categoryLabel(run.taskCategory)}</Badge>
              <Badge className={runtimeTone(run.runtime)}>{runtimeLabel(run.runtime)}</Badge>
              {deck && (
                <Badge className="bg-[#92E4DD]/10 text-[#92E4DD] border-[#92E4DD]/25 normal-case truncate max-w-[160px]" title={deck}>
                  ◆ {deck}
                </Badge>
              )}
            </div>
            <h2 className="font-semibold text-2xl leading-snug pr-2">{run.title}</h2>
            <p className="text-sm text-white/45 flex flex-wrap gap-x-2 gap-y-0.5 items-center">
              <Badge className={meta.tone}>{meta.label}</Badge>
              <span title={new Date(run.updatedAt).toLocaleString()}>Updated {formatRelativeTime(run.updatedAt)}</span>
            </p>
          </div>
          <div className="flex items-start gap-2 shrink-0">
            {queueNav && (
              <DrawerNav
                index={queueNav.index}
                total={queueNav.runs.length}
                onPrev={queueNav.onPrev}
                onNext={queueNav.onNext}
              />
            )}
            <button type="button" onClick={onClose} className="text-white/60 hover:text-white px-1" aria-label="Close">
              ✕
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {(run.status === "plan_pending" || run.status === "queued") && (
          <PlanReviewPanel
            run={run}
            onRefresh={onRefresh}
            onApproved={onApproved}
            onApprovedAndNext={onApprovedAndNext}
          />
        )}
        {(run.status === "plan_approved" || run.status === "running") && (
          <ExecutionPanel run={run} onRefresh={onRefresh} />
        )}
        {(run.status === "review" || run.status === "failed") && (
          <ResultReviewPanel
            run={run}
            onRefresh={onRefresh}
            onRetry={onRetry}
            onDoneAndNext={onDoneAndNext}
          />
        )}
        {run.status === "done" && <DoneReviewPanel run={run} />}
        {run.status === "cancelled" && (
          <p className="text-sm text-white/50">This task was removed from Operations.</p>
        )}
      </div>
    </div>
    </div>
  );
}
