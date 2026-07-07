import { useCallback, useEffect, useState } from "react";
import type { AgentWithHealth, Artifact, Run } from "@agent-dealer/shared";
import { agentSummary } from "../../AgentConfigFields";
import PhaseConfigRow from "../agents/PhaseConfigRow";
import {
  cancelRun,
  fetchLogTail,
  fetchRunDetail,
  kickRun,
  type StreamTraceContent,
  type UsageSummary,
} from "../../api";
import {
  agentPhaseBudgetFromJson,
  budgetFormEmpty,
  phaseBudgetFromForm,
  runPhaseBudgetFromRun,
  type BudgetFormValue,
} from "../../lib/budgetForm";
import { TracePanel, UsagePanel } from "../panels/TraceUsage";

type Props = {
  run: Run;
  agents: AgentWithHealth[];
  onRefresh: () => void;
};

export default function ExecutionPanel({ run, agents, onRefresh }: Props) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [traceSummary, setTraceSummary] = useState<StreamTraceContent | null>(null);
  const [transcriptText, setTranscriptText] = useState("");
  const [executeModel, setExecuteModel] = useState("");
  const [executeBudget, setExecuteBudget] = useState<BudgetFormValue>(budgetFormEmpty());
  const [busy, setBusy] = useState(false);

  const agent = agents.find((a) => a.id === run.agentId);
  const runtime = run.runtime ?? agent?.runtime ?? "claude_code";

  const load = useCallback(async () => {
    const detail = await fetchRunDetail(run.id);
    setArtifacts(detail.artifacts);
    setUsageSummary(detail.usageSummary ?? null);
    setTraceSummary(detail.traceSummary ?? null);
  }, [run.id]);

  const isRunning = run.status === "running";
  const isWaiting = run.status === "plan_approved";

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  useEffect(() => {
    setExecuteModel(run.executeModel ?? "");
    const runExecute = runPhaseBudgetFromRun(run.budgetJson, "execute");
    setExecuteBudget(
      runExecute.maxTurns || runExecute.maxBudgetUsd
        ? runExecute
        : agentPhaseBudgetFromJson(agent?.defaultExecuteBudgetJson)
    );
  }, [run.id, run.executeModel, run.budgetJson, agent?.defaultExecuteBudgetJson]);

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
        <>
          <PhaseConfigRow
            phase="Execution"
            runtime={runtime}
            model={executeModel}
            onModelChange={setExecuteModel}
            budget={executeBudget}
            onBudgetChange={setExecuteBudget}
            defaultModelId={agent?.defaultExecuteModel}
            disabled={busy}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => act(() => kickRun(run.id, executeModel || null, phaseBudgetFromForm(executeBudget)))}
            className="btn-ghost px-3 py-2 w-full"
          >
            Run now (skip queue wait)
          </button>
        </>
      )}

      {traceSummary && <TracePanel trace={traceSummary} />}
      {usageSummary && <UsagePanel summary={usageSummary} />}

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
