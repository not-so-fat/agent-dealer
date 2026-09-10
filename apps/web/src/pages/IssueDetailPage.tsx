import { useEffect, useState } from "react";
import { fetchIssueDetail, guideIssue, startIssue, type IssueDetail } from "../api";
import IssueStatusBadge from "../components/issues/IssueStatusBadge";
import IssueTimeline from "../components/issues/IssueTimeline";

type Props = {
  issueId: string;
  onBack: () => void;
};

export default function IssueDetailPage({ issueId, onBack }: Props) {
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [guidance, setGuidance] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = () => fetchIssueDetail(issueId).then(setDetail).catch((e) => setError(String(e)));

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 4000);
    return () => clearInterval(poll);
  }, [issueId]);

  if (error) return <div className="p-6 text-red-300 text-sm">{error}</div>;
  if (!detail) return <div className="p-6 text-white/50 text-sm">Loading…</div>;

  const { issue, timeline, forecast, humanActions, usageSummary } = detail;
  const durationMs = Date.now() - new Date(issue.createdAt).getTime();
  const durationMin = Math.floor(durationMs / 60_000);

  const submitGuidance = async () => {
    if (!guidance.trim()) return;
    await guideIssue(issueId, guidance);
    setGuidance("");
    refresh();
  };

  const handleStart = async () => {
    await startIssue(issueId);
    refresh();
  };

  return (
    <div className="flex-1 min-h-0 flex overflow-hidden">
      <div className="flex-1 min-w-0 overflow-y-auto px-6 py-4">
        <button type="button" onClick={onBack} className="text-sm text-white/50 hover:text-white mb-3">
          ← Issues
        </button>

        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-lg font-semibold text-white/90">{issue.title}</h2>
            <p className="text-xs text-white/45 mt-1">
              Owner: <span className="capitalize">{issue.currentOwner}</span>
              {issue.currentIntent ? ` · ${issue.currentIntent}` : ""}
            </p>
            <div className="flex gap-3 mt-2 text-xs text-white/40">
              {issue.prUrl && <a href={issue.prUrl} target="_blank" rel="noreferrer" className="text-cyber-teal hover:underline">PR #{issue.prNumber}</a>}
              {issue.externalUrl && <a href={issue.externalUrl} target="_blank" rel="noreferrer" className="text-cyber-teal hover:underline">{issue.externalLabel ?? "External link"}</a>}
              <span>Round {issue.currentRound}/{issue.maxReviewRounds}</span>
              <span>{durationMin}m elapsed</span>
              <span>${usageSummary.totalCostUsd.toFixed(2)}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <IssueStatusBadge status={issue.status} />
            {issue.status === "ready" && (
              <button type="button" className="btn-gold px-3 py-1.5 text-sm" onClick={handleStart}>Start</button>
            )}
          </div>
        </div>

        <div className="border-t border-white/10 pt-3">
          <IssueTimeline events={timeline} />
        </div>

        <div className="mt-4 flex gap-2">
          <input
            className="flex-1 bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
            placeholder="Guide this issue…"
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitGuidance()}
          />
          <button type="button" className="btn-gold px-4" onClick={submitGuidance}>Send</button>
        </div>
      </div>

      <aside className="w-72 shrink-0 border-l border-white/10 px-4 py-4 overflow-y-auto">
        <h3 className="text-xs uppercase tracking-wide text-white/40 mb-2">Intent forecast</h3>
        <p className="text-sm text-white/85 mb-1">Now: {forecast.now}</p>
        {forecast.next && <p className="text-sm text-white/55">Next: {forecast.next}</p>}

        {humanActions.filter((a) => a.status === "open").length > 0 && (
          <div className="mt-4 p-3 rounded border border-red-400/30 bg-red-500/10">
            <p className="text-xs text-red-300 font-medium">Human action needed</p>
            {humanActions.filter((a) => a.status === "open").map((a) => (
              <p key={a.id} className="text-sm text-white/80 mt-1">{a.question}</p>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}
