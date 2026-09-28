// NOT-287: compact, dismissible first-issue strip for a truly fresh issue
// history. One panel, above the normal Issues content: the smallest path
// (agents → repository → issue), a primary action to the next incomplete
// step, and a dismiss control. Capacity status is informational copy here —
// never a prerequisite that blocks the first issue.
import { Link } from "react-router-dom";
import { nextFirstIssueStep } from "../../lib/firstIssue";

type Props = {
  agentCount: number;
  onStartIssue: () => void;
  onDismiss: () => void;
};

export default function FirstIssueStrip({ agentCount, onStartIssue, onDismiss }: Props) {
  const step = nextFirstIssueStep(agentCount);
  return (
    <section
      aria-label="Create your first issue"
      data-testid="first-issue-strip"
      className="mb-4 rounded border border-[#C4B643]/40 bg-[#C4B643]/5 px-4 py-3"
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="font-ui-display text-sm font-medium text-white/90">
            Create your first issue
          </p>
          <p className="mt-1 text-sm text-white/60">
            Connect a developer and a reviewer agent, pick a GitHub repository, then
            create the issue. Capacity status in the header is informational — it never
            blocks creating an issue.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {step === "agents" ? (
              <Link
                to="/agents"
                data-testid="first-issue-primary"
                className="btn-gold px-4 py-2 text-sm"
              >
                Configure agents
              </Link>
            ) : (
              <button
                type="button"
                data-testid="first-issue-primary"
                className="btn-gold px-4 py-2 text-sm"
                onClick={onStartIssue}
              >
                New issue
              </button>
            )}
            {step === "agents" && (
              <span className="text-xs text-white/40">
                then pick a repository and create the issue
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          aria-label="Dismiss first-issue guide"
          title="Dismiss"
          onClick={onDismiss}
          className="shrink-0 rounded px-2 py-1 text-sm text-white/40 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyber-teal/45"
        >
          ✕
        </button>
      </div>
    </section>
  );
}
