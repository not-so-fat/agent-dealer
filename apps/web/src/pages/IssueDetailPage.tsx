import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AgentWithHealth } from "@agent-dealer/shared";
import { fetchIssueDetail, type IssueDetail } from "../api";
import IssueDetailBody from "../components/issues/IssueDetailBody";

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

  const refresh = () =>
    fetchIssueDetail(issueId)
      .then((d) => {
        setDetail(d);
        setError(null);
        setNotFound(false);
      })
      .catch((e) => {
        const msg = String(e).replace(/^Error:\s*/i, "").trim();
        if (/^not found$/i.test(msg)) {
          setNotFound(true);
          setError(null);
          setDetail(null);
        } else {
          setError(msg);
          setNotFound(false);
        }
      });

  useEffect(() => {
    // Route reuse no longer unmounts this page when only :issueId changes — clear
    // the fetched state so issue A's detail cannot overlay issue B. Draft state
    // (edit/guidance) lives in IssueDetailBody, which remounts per issueId below.
    setDetail(null);
    setError(null);
    setNotFound(false);
    refresh();
    const poll = setInterval(refresh, 4000);
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
