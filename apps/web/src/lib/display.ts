import type { Run, RunStatus, Runtime, TaskCategory } from "@agent-dealer/shared";

/** Relative time — Autoship/Botfarm-style "2m ago" scan labels. */
export function formatRelativeTime(iso: string, now = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Elapsed since timestamp — for running slots (Symphony/Maestro live feel). */
export function formatElapsed(iso: string, now = Date.now()): string {
  const ms = Math.max(0, now - new Date(iso).getTime());
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  if (hr > 0) return `${hr}h ${min % 60}m`;
  if (min > 0) return `${min}m ${sec % 60}s`;
  return `${sec}s`;
}

/** Wall-clock duration from usage artifacts — minutes when ≥60s. */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min >= 60) {
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
  }
  if (min > 0) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  return `${sec}s`;
}

export function runtimeLabel(runtime: Runtime | null | undefined): string {
  if (runtime === "claude_code") return "Claude";
  if (runtime === "cursor_local") return "Cursor";
  return "No agent";
}

export function runtimeTone(runtime: Runtime | null | undefined): string {
  if (runtime === "claude_code") return "bg-[#D4A574]/20 text-[#E8C9A8] border-[#D4A574]/40";
  if (runtime === "cursor_local") return "bg-[#7EB8FF]/15 text-[#A8D4FF] border-[#7EB8FF]/35";
  return "bg-white/5 text-white/50 border-white/15";
}

export function categoryLabel(cat: TaskCategory): string {
  const map: Record<TaskCategory, string> = {
    code: "Code",
    communication: "Slack",
    email: "Email",
    research: "Research",
    content: "Content",
    other: "Other",
  };
  return map[cat] ?? cat;
}

export function sourceLabel(run: Pick<Run, "source" | "externalId" | "externalLabel">): string {
  if (run.source === "linear" && run.externalLabel) return run.externalLabel;
  if (run.source === "linear" && run.externalId) return run.externalId;
  if (run.source === "linear") return "Linear";
  return "Manual";
}

export type StatusMeta = {
  label: string;
  hint?: string;
  tone: string;
  accent: string;
};

/** Pipeline column labels — maps to PRD §9 + Autoship stage naming. */
export function statusMeta(status: RunStatus, context?: "intake" | "ops"): StatusMeta {
  switch (status) {
    case "plan_pending":
      return {
        label: context === "ops" ? "Review Plan" : "Planning",
        hint: context === "ops" ? "Your sign-off required" : "Agent is writing the plan",
        tone: "bg-cyber-violet/15 text-cyber-violet-light border-cyber-violet/35",
        accent: "border-l-cyber-violet",
      };
    case "plan_approved":
      return {
        label: "Queued",
        hint: "Approved — waiting for slot",
        tone: "bg-sky-500/15 text-sky-200 border-sky-400/30",
        accent: "border-l-sky-400",
      };
    case "queued":
      return {
        label: "Queued",
        tone: "bg-sky-500/15 text-sky-200 border-sky-400/30",
        accent: "border-l-sky-400",
      };
    case "running":
      return {
        label: "Running",
        hint: "Agent executing",
        tone: "bg-[#92E4DD]/15 text-[#92E4DD] border-[#92E4DD]/35",
        accent: "border-l-[#92E4DD]",
      };
    case "review":
      return {
        label: "Needs Review",
        hint: "Your sign-off required",
        tone: "bg-[#C4B643]/20 text-[#E8DC7A] border-[#C4B643]/40",
        accent: "border-l-[#C4B643]",
      };
    case "done":
      return {
        label: "Done",
        tone: "bg-emerald-500/10 text-emerald-300/90 border-emerald-400/25",
        accent: "border-l-emerald-400/60",
      };
    case "failed":
      return {
        label: "Failed",
        hint: "Retry from result review",
        tone: "bg-red-500/15 text-red-300 border-red-400/30",
        accent: "border-l-red-400",
      };
    case "cancelled":
      return {
        label: "Removed",
        hint: "Dismissed from Operations",
        tone: "bg-white/5 text-white/40 border-white/10",
        accent: "border-l-white/20",
      };
    default:
      return {
        label: status,
        tone: "bg-white/5 text-white/60 border-white/15",
        accent: "border-l-white/20",
      };
  }
}

export function deckLabel(run: Pick<Run, "deckName" | "deckId">): string | null {
  if (run.deckName) return run.deckName;
  if (run.deckId) return `deck ${run.deckId.slice(0, 8)}…`;
  return null;
}
