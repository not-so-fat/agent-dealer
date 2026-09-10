import type { IssueStatus } from "@agent-dealer/shared";

const STYLES: Record<IssueStatus, string> = {
  ready: "bg-white/10 text-white/70 border-white/20",
  developing: "bg-cyber-violet/20 text-cyber-violet-light border-cyber-violet/40",
  reviewing: "bg-cyber-gold/20 text-[#E8DC7A] border-cyber-gold/40",
  repairing: "bg-cyber-violet/25 text-cyber-violet-light border-cyber-violet/50",
  final_review: "bg-amber-500/20 text-amber-300 border-amber-400/40",
  needs_human: "bg-red-500/20 text-red-300 border-red-400/40",
  done: "bg-cyber-teal/20 text-cyber-teal border-cyber-teal/40",
  closed: "bg-white/5 text-white/40 border-white/10",
};

const LABELS: Record<IssueStatus, string> = {
  ready: "Ready",
  developing: "Developing",
  reviewing: "Reviewing",
  repairing: "Repairing",
  final_review: "Final review",
  needs_human: "Needs human",
  done: "Done",
  closed: "Closed",
};

export default function IssueStatusBadge({ status }: { status: IssueStatus }) {
  return (
    <span className={`text-xs leading-none px-2 py-1 rounded border tabular-nums ${STYLES[status]}`}>
      {LABELS[status]}
    </span>
  );
}
