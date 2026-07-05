import { useCallback, useEffect, useState } from "react";
import type { AgentWithHealth, Artifact, Run } from "@agent-dealer/shared";
import { agentSummary } from "../../AgentConfigFields";
import ModelSelect from "../agents/ModelSelect";
import {
  artifactMarkdown,
  cancelRun,
  draftPlan,
  fetchRunDetail,
  latestByPhase,
  updatePlan,
  type StreamTraceContent,
  type UsageContent,
} from "../../api";
import { TracePanel, UsagePanel } from "../panels/TraceUsage";
import RemoveFromOpsAction from "./RemoveFromOpsAction";

type Props = {
  run: Run;
  agents: AgentWithHealth[];
  onRefresh: () => void;
  onApproved?: () => void;
  onApprovedAndNext?: () => void;
};

export default function PlanReviewPanel({ run, agents, onRefresh, onApproved, onApprovedAndNext }: Props) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [planText, setPlanText] = useState("");
  const [planModel, setPlanModel] = useState("");
  const [executeModel, setExecuteModel] = useState("");
  const [busy, setBusy] = useState(false);

  const agent = agents.find((a) => a.id === run.agentId);
  const runtime = run.runtime ?? agent?.runtime ?? "claude_code";

  const load = useCallback(async () => {
    const detail = await fetchRunDetail(run.id);
    setArtifacts(detail.artifacts);
    const approved = detail.artifacts.find((a) => a.kind === "approved_plan");
  const agentPlan = detail.artifacts.find((a) => a.kind === "draft_plan");
    const src = approved ?? agentPlan;
    if (src) setPlanText(artifactMarkdown(src));
  }, [run.id]);

  const hasPlan = artifacts.some((a) => a.kind === "draft_plan");
  const agentPlanning = run.status === "plan_pending" && !hasPlan;
  const tracePlan = latestByPhase<StreamTraceContent>(artifacts, "stream_trace", "plan");
  const usagePlan = latestByPhase<UsageContent>(artifacts, "usage", "plan");

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  useEffect(() => {
    setPlanModel(run.planModel ?? "");
    setExecuteModel(run.executeModel ?? "");
  }, [run.id, run.planModel, run.executeModel]);

  useEffect(() => {
    if (!agentPlanning) return;
    const t = setInterval(() => load().catch(console.error), 3000);
    return () => clearInterval(t);
  }, [agentPlanning, load]);

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
      </section>

      <section className="space-y-2">
        <div className="heading-section">Plan</div>
        {agentPlanning && (
          <p className="text-sm text-[#92E4DD] animate-pulse">Agent is writing the plan…</p>
        )}
        {hasPlan && (
          <button
            type="button"
            disabled={busy || agentPlanning}
            onClick={() => act(() => draftPlan(run.id, planModel || null))}
            className="btn-ghost px-3 py-1.5 disabled:opacity-40"
          >
            Ask agent to replan
          </button>
        )}
        <ModelSelect
          runtime={runtime}
          label="Planning model"
          value={planModel}
          onChange={setPlanModel}
          defaultModelId={agent?.defaultPlanModel}
          disabled={busy || agentPlanning}
        />
        <textarea
          className="field-mono min-h-[min(420px,45vh)] resize-y leading-relaxed"
          value={planText}
          readOnly={agentPlanning}
          onChange={!agentPlanning ? (e) => setPlanText(e.target.value) : undefined}
          placeholder={
            agentPlanning ? "Plan will appear here when the agent finishes…" : "Edit if needed, then approve"
          }
        />
        {hasPlan && !agentPlanning && (
          <div className="flex gap-2 flex-wrap">
            <button
              type="button"
              disabled={busy || !planText.trim()}
              onClick={() => act(() => updatePlan(run.id, planText, false))}
              className="btn-ghost px-4 py-2 disabled:opacity-40"
            >
              Save edits
            </button>
            <ModelSelect
              runtime={runtime}
              label="Execution model"
              value={executeModel}
              onChange={setExecuteModel}
              defaultModelId={agent?.defaultExecuteModel}
              disabled={busy}
            />
            <button
              type="button"
              disabled={busy || !planText.trim()}
              onClick={() =>
                act(async () => {
                  await updatePlan(run.id, planText, true, executeModel || null);
                  onApproved?.();
                  onApprovedAndNext?.();
                })
              }
              className="btn-gold px-4 py-2 disabled:opacity-40 w-full sm:w-auto"
            >
              Approve & next →
            </button>
          </div>
        )}
      </section>

      {tracePlan && <TracePanel trace={tracePlan} />}
      {usagePlan && <UsagePanel usage={usagePlan} />}

      <RemoveFromOpsAction
        busy={busy}
        onRemoved={() =>
          act(async () => {
            await cancelRun(run.id);
            onApprovedAndNext?.();
          })
        }
      />
    </div>
  );
}
