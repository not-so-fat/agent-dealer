import { useCallback, useEffect, useState } from "react";
import type { AgentWithHealth, Artifact, Run } from "@agent-dealer/shared";
import { agentSummary } from "../../AgentConfigFields";
import ModelSelect from "../agents/ModelSelect";
import {
  artifactMarkdown,
  cancelRun,
  draftPlan,
  fetchRunDetail,
  latestArtifact,
  latestByPhase,
  updatePlan,
  type StreamTraceContent,
  type UsageContent,
} from "../../api";
import { TracePanel, UsagePanel } from "../panels/TraceUsage";
import MarkdownBody from "../ui/MarkdownBody";
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
  const [replanning, setReplanning] = useState(false);
  const [editing, setEditing] = useState(false);

  const agent = agents.find((a) => a.id === run.agentId);
  const runtime = run.runtime ?? agent?.runtime ?? "claude_code";

  const load = useCallback(async () => {
    const detail = await fetchRunDetail(run.id);
    setArtifacts(detail.artifacts);
    const approved = latestArtifact(detail.artifacts, "approved_plan");
    const agentPlan = latestArtifact(detail.artifacts, "draft_plan");
    const src = approved ?? agentPlan;
    if (src) setPlanText(artifactMarkdown(src));
  }, [run.id]);

  const hasPlan = artifacts.some((a) => a.kind === "draft_plan");
  const agentPlanning = run.status === "plan_pending" && !hasPlan;
  const planning = agentPlanning || replanning;
  const tracePlan = latestByPhase<StreamTraceContent>(artifacts, "stream_trace", "plan");
  const usagePlan = latestByPhase<UsageContent>(artifacts, "usage", "plan");

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  useEffect(() => {
    setPlanModel(run.planModel ?? "");
    setExecuteModel(run.executeModel ?? "");
    setReplanning(false);
    setEditing(false);
  }, [run.id, run.planModel, run.executeModel]);

  useEffect(() => {
    if (!planning) return;
    const t = setInterval(() => {
      load().catch(console.error);
      onRefresh();
    }, 3000);
    return () => clearInterval(t);
  }, [planning, load, onRefresh]);

  const requestReplan = async () => {
    const before = latestArtifact(artifacts, "draft_plan")?.createdAt;
    setReplanning(true);
    setBusy(true);
    try {
      await draftPlan(run.id, planModel || null);
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const detail = await fetchRunDetail(run.id);
        setArtifacts(detail.artifacts);
        const latest = latestArtifact(detail.artifacts, "draft_plan");
        if (latest && latest.createdAt !== before) {
          setPlanText(artifactMarkdown(latest));
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      onRefresh();
    } catch (e) {
      alert(String(e));
    } finally {
      setReplanning(false);
      setBusy(false);
    }
  };

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
        {planning && (
          <p className="text-sm text-[#92E4DD] animate-pulse">
            {replanning ? "Agent is replanning…" : "Agent is writing the plan…"}
          </p>
        )}
        <ModelSelect
          runtime={runtime}
          label="Planning model"
          value={planModel}
          onChange={setPlanModel}
          defaultModelId={agent?.defaultPlanModel}
          disabled={busy || planning}
        />
        {planning ? (
          <div className="field-mono min-h-[min(420px,45vh)] flex items-center justify-center text-sm text-white/40">
            Plan will appear here when the agent finishes…
          </div>
        ) : editing || !planText.trim() ? (
          <textarea
            className="field-mono min-h-[min(420px,45vh)] resize-y leading-relaxed"
            value={planText}
            onChange={(e) => setPlanText(e.target.value)}
            placeholder="Edit if needed, then approve"
          />
        ) : (
          <div className="markdown-body-panel">
            <MarkdownBody source={planText} />
          </div>
        )}
        {hasPlan && !planning && (
          <div className="flex flex-wrap items-center justify-between gap-2 -mt-1">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditing((e) => !e)}
                className="btn-ghost text-xs px-2 py-1 disabled:opacity-40"
              >
                {editing ? "Show preview" : "Edit markdown"}
              </button>
              {editing && (
                <button
                  type="button"
                  disabled={busy || !planText.trim()}
                  onClick={() => act(() => updatePlan(run.id, planText, false))}
                  className="btn-ghost text-xs px-2 py-1 disabled:opacity-40"
                >
                  Save edits
                </button>
              )}
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => requestReplan()}
              className="btn-ghost text-xs px-2 py-1 disabled:opacity-40"
            >
              Ask agent to replan
            </button>
          </div>
        )}
        {hasPlan && !planning && (
          <section className="space-y-2 pt-3 border-t border-white/10">
            <div className="heading-section">Your Decision</div>
            <div className="flex flex-col sm:flex-row sm:items-end gap-2">
              <div className="flex-1 min-w-0">
                <ModelSelect
                  runtime={runtime}
                  label="Execution model"
                  value={executeModel}
                  onChange={setExecuteModel}
                  defaultModelId={agent?.defaultExecuteModel}
                  disabled={busy}
                />
              </div>
              <button
                type="button"
                disabled={busy || !planText.trim()}
                onClick={() =>
                  act(async () => {
                    await updatePlan(run.id, planText, true, {
                      planModel: planModel || null,
                      executeModel: executeModel || null,
                    });
                    onApproved?.();
                    onApprovedAndNext?.();
                  })
                }
                className="btn-gold px-5 py-2 disabled:opacity-40 shrink-0 sm:min-w-[11rem]"
              >
                Approve & next →
              </button>
            </div>
          </section>
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
