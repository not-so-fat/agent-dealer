import { useCallback, useEffect, useState } from "react";
import type { Artifact, Run } from "@agent-dealer/shared";
import { agentSummary } from "../../AgentConfigFields";
import {
  cancelRun,
  fetchLogTail,
  fetchRunDetail,
  kickRun,
  latestByPhase,
  type StreamTraceContent,
  type UsageContent,
} from "../../api";
import { TracePanel, UsagePanel } from "../panels/TraceUsage";

type Props = {
  run: Run;
  onRefresh: () => void;
};

export default function ExecutionPanel({ run, onRefresh }: Props) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [transcriptText, setTranscriptText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const detail = await fetchRunDetail(run.id);
    setArtifacts(detail.artifacts);
  }, [run.id]);

  const traceExec = latestByPhase<StreamTraceContent>(artifacts, "stream_trace", "execute");
  const usageExec = latestByPhase<UsageContent>(artifacts, "usage", "execute");
  const isRunning = run.status === "running";
  const isWaiting = run.status === "plan_approved";

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  useEffect(() => {
    if (!isRunning && !isWaiting) return;
    const t = setInterval(() => load().catch(console.error), 3000);
    return () => clearInterval(t);
  }, [isRunning, isWaiting, load]);

  useEffect(() => {
    if (!isRunning) return;
    fetchLogTail(run.id, "stream_trace")
      .then(setTranscriptText)
      .catch(() => setTranscriptText(""));
  }, [isRunning, run.id, artifacts.length]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
      onRefresh();
    } catch (e) {
      alert(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <section className="space-y-1">
        <div className="heading-section">Agent</div>
        <p className="text-body">{agentSummary(run)}</p>
        {isWaiting && (
          <p className="text-sm text-[#92E4DD]">Approved — waiting for execution slot…</p>
        )}
        {isRunning && <p className="text-sm text-[#92E4DD] animate-pulse">Executing…</p>}
      </section>

      {isWaiting && (
        <button
          type="button"
          disabled={busy}
          onClick={() => act(() => kickRun(run.id))}
          className="btn-ghost px-3 py-2 w-full"
        >
          Run now (skip queue wait)
        </button>
      )}

      {traceExec && <TracePanel trace={traceExec} label="Live trace" />}
      {usageExec && <UsagePanel usage={usageExec} />}

      {transcriptText && (
        <section className="space-y-2">
          <div className="heading-section">Log Tail</div>
          <textarea className="field-mono min-h-[140px] resize-y text-sm" value={transcriptText} readOnly />
        </section>
      )}

      {(isRunning || isWaiting) && (
        <button
          type="button"
          disabled={busy}
          onClick={() => act(() => cancelRun(run.id))}
          className="btn-ghost-danger w-full py-2"
        >
          Cancel run
        </button>
      )}
    </div>
  );
}
