import { useCallback, useEffect, useState } from "react";
import type { Artifact, Run } from "@agent-dealer/shared";
import { agentSummary } from "../../AgentConfigFields";
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
  onRefresh: () => void;
  onApproved?: () => void;
  onApprovedAndNext?: () => void;
};

export default function PlanReviewPanel({ run, onRefresh, onApproved, onApprovedAndNext }: Props) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [planText, setPlanText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const detail = await fetchRunDetail(run.id);
    setArtifacts(detail.artifacts);
    const approved = detail.artifacts.find((a) => a.kind === "approved_plan");
    const draft = detail.artifacts.find((a) => a.kind === "draft_plan");
    const src = approved ?? draft;
    if (src) setPlanText(artifactMarkdown(src));
  }, [run.id]);

  const hasAgentPlan = artifacts.some((a) => a.kind === "draft_plan");
  const planDrafting = run.status === "plan_pending" && !hasAgentPlan;
  const tracePlan = latestByPhase<StreamTraceContent>(artifacts, "stream_trace", "plan");
  const usagePlan = latestByPhase<UsageContent>(artifacts, "usage", "plan");

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  useEffect(() => {
    if (!planDrafting) return;
    const t = setInterval(() => load().catch(console.error), 3000);
    return () => clearInterval(t);
  }, [planDrafting, load]);

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
        <div className="heading-section">Review Plan</div>
        {planDrafting && (
          <p className="text-sm text-[#92E4DD] animate-pulse">Agent is drafting a plan…</p>
        )}
        {hasAgentPlan && (
          <button
            type="button"
            disabled={busy || planDrafting}
            onClick={() => act(() => draftPlan(run.id))}
            className="btn-ghost px-3 py-1.5 disabled:opacity-40"
          >
            Ask agent to re-draft
          </button>
        )}
        <textarea
          className="field-mono min-h-[min(420px,45vh)] resize-y leading-relaxed"
          value={planText}
          readOnly={planDrafting}
          onChange={!planDrafting ? (e) => setPlanText(e.target.value) : undefined}
          placeholder={planDrafting ? "Waiting for agent plan…" : "Edit the plan, then approve or save revisions"}
        />
        {hasAgentPlan && !planDrafting && (
          <div className="flex gap-2 flex-wrap">
            <button
              type="button"
              disabled={busy || !planText.trim()}
              onClick={() => act(() => updatePlan(run.id, planText, false))}
              className="btn-ghost px-4 py-2 disabled:opacity-40"
            >
              Save revisions
            </button>
            <button
              type="button"
              disabled={busy || !planText.trim()}
              onClick={() =>
                act(async () => {
                  await updatePlan(run.id, planText, true);
                  onApproved?.();
                  onApprovedAndNext?.();
                })
              }
              className="btn-gold px-4 py-2 disabled:opacity-40"
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
