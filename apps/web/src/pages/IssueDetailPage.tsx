import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { AgentWithHealth } from "@agent-dealer/shared";
import { fetchIssueDetail, type IssueDetail } from "../api";
import IssueDetailBody from "../components/issues/IssueDetailBody";
import { createLatestRequestGate } from "../lib/latestRequest";

type Props = {
  issueId: string;
  agents: AgentWithHealth[];
  /** Lets the shell's open-action badge/list catch up after a resolution here. */
  onHumanActionsChanged: () => void;
};

export default function IssueDetailPage({ issueId, agents, onHumanActionsChanged }: Props) {
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // NOT-490: the poll and post-mutation refreshes overlap — the gate applies only
  // responses newer than the last applied one, and the returned promise settles once
  // this call's response is applied (or superseded), so a save can stay busy until the
  // committed state is on screen.
  const gate = useRef(createLatestRequestGate()).current;
  const refresh = (): Promise<void> =>
    gate.run(
      () => fetchIssueDetail(issueId),
      (d) => {
        setDetail(d);
        setError(null);
        setNotFound(false);
      },
      (e) => {
        const msg = String(e).replace(/^Error:\s*/i, "").trim();
        if (/^not found$/i.test(msg)) {
          setNotFound(true);
          setError(null);
          setDetail(null);
        } else {
          setError(msg);
          setNotFound(false);
        }
      }
    );

  useEffect(() => {
    // Route reuse no longer unmounts this page when only :issueId changes — clear
    // the fetched state so issue A's detail cannot overlay issue B. Draft state
    // (edit/guidance) lives in IssueDetailBody, which remounts per issueId below.
    setDetail(null);
    setError(null);
    setNotFound(false);
    gate.invalidate();
    void refresh();
    const poll = setInterval(() => void refresh(), 4000);
    return () => clearInterval(poll);
  }, [issueId]);

  if (notFound) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-10">
        <div className="max-w-md space-y-3">
          <h2 className="text-lg font-semibold text-white/90">Issue not found</h2>
          <p className="text-sm text-white/55">
            No issue exists for this ID — it may have been deleted, or the link is wrong.
          </p>
          <Link to="/issues" className="font-ui-display inline-block text-sm text-cyber-teal hover:underline">
            ← Back to Issues
          </Link>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-6 space-y-3">
        <p className="text-red-300 text-sm">{error}</p>
        <Link to="/issues" className="font-ui-display inline-block text-sm text-cyber-teal hover:underline">
          ← Back to Issues
        </Link>
      </div>
    );
  }
  if (!detail) return <div className="p-6 text-white/50 text-sm">Loading…</div>;

  return (
    <IssueDetailBody
      key={issueId}
      issueId={issueId}
      detail={detail}
      agents={agents}
      onHumanActionsChanged={onHumanActionsChanged}
      refresh={refresh}
      onError={(message) => setError(message)}
    />
  );
}
