import { useCallback, useEffect, useState } from "react";
import type { AgentWithHealth, Artifact, PlanTriageContent, Run } from "@agent-dealer/shared";
import { agentSummary } from "../../AgentConfigFields";
import PhaseConfigRow from "../agents/PhaseConfigRow";
import {
  artifactMarkdown,
  cancelRun,
  draftPlan,
  fetchRunDetail,
  latestArtifact,
  parseArtifact,
  submitPlanAnswers,
  updatePlan,
  type StreamTraceContent,
  type UsageSummary,
} from "../../api";
import PlanQuestionsCard, {
  planAnswersFromDrafts,
  planAnswersHaveFreeForm,
  planAnswersReady,
  type AnswerDraft,
} from "./PlanQuestionsCard";
import {
  budgetFormEmpty,
  phaseBudgetPayload,
  runPhaseBudgetFromRun,
  type BudgetFormValue,
} from "../../lib/budgetForm";
import { TracePanel, UsagePanel } from "../panels/TraceUsage";
import MarkdownBody from "../ui/MarkdownBody";
import CollapsibleSection from "../ui/CollapsibleSection";
import RemoveFromOpsAction from "./RemoveFromOpsAction";

type Props = {
  run: Run;
  agents: AgentWithHealth[];
  onRefresh: () => void;
  onApproved?: () => void;
  onApprovedAndNext?: () => void;
};

function planSummaryLine(markdown: string): string {
  const line = markdown
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("```"));
  return line?.replace(/^[-*]\s+/, "").slice(0, 160) ?? "Plan draft ready";
}

export default function PlanReviewPanel({ run, agents, onRefresh, onApproved, onApprovedAndNext }: Props) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [traceSummary, setTraceSummary] = useState<StreamTraceContent | null>(null);
  const [planText, setPlanText] = useState("");
  const [planModel, setPlanModel] = useState("");
  const [executeModel, setExecuteModel] = useState("");
  const [planBudget, setPlanBudget] = useState<BudgetFormValue>(budgetFormEmpty());
  const [executeBudget, setExecuteBudget] = useState<BudgetFormValue>(budgetFormEmpty());
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, AnswerDraft>>({});
  const [planExpanded, setPlanExpanded] = useState(false);
  const [replanOpen, setReplanOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [replanning, setReplanning] = useState(false);
  const [editing, setEditing] = useState(false);

  const agent = agents.find((a) => a.id === run.agentId);
  const runtime = run.runtime ?? agent?.runtime ?? "claude_code";

  const load = useCallback(async () => {
    const detail = await fetchRunDetail(run.id);
    setArtifacts(detail.artifacts);
    setUsageSummary(detail.usageSummary ?? null);
    setTraceSummary(detail.traceSummary ?? null);
    const approved = latestArtifact(detail.artifacts, "approved_plan");
    const agentPlan = latestArtifact(detail.artifacts, "draft_plan");
    const src = approved ?? agentPlan;
    if (src) setPlanText(artifactMarkdown(src));
  }, [run.id]);

  const hasPlan = artifacts.some((a) => a.kind === "draft_plan");
  const agentPlanning = run.status === "plan_pending" && !hasPlan;
  const planning = agentPlanning || replanning;

  const triageArt = latestArtifact(artifacts, "plan_triage");
  const answersArt = latestArtifact(artifacts, "plan_answers");
  const triage = triageArt ? parseArtifact<PlanTriageContent>(triageArt) : null;
  const openQuestions =
    run.status === "plan_pending" &&
    triage &&
    !triage.consumed &&
    triage.questions.length > 0 &&
    (!answersArt || answersArt.createdAt <= triageArt!.createdAt)
      ? triage.questions
      : [];

  const answersReady = planAnswersReady(openQuestions, answerDrafts);
  const answersFreeForm = planAnswersHaveFreeForm(openQuestions, answerDrafts);

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  useEffect(() => {
    setPlanModel(run.planModel ?? "");
    setExecuteModel(run.executeModel ?? "");
    setPlanBudget(runPhaseBudgetFromRun(run.budgetJson, "plan"));
    setExecuteBudget(runPhaseBudgetFromRun(run.budgetJson, "execute"));
    setAnswerDrafts({});
    setPlanExpanded(false);
    setReplanOpen(false);
    setDetailsOpen(false);
    setReplanning(false);
    setEditing(false);
  }, [run.id, run.planModel, run.executeModel, run.budgetJson]);

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
      await draftPlan(run.id, planModel || null, phaseBudgetPayload(planBudget, run.budgetJson, "plan"));
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const detail = await fetchRunDetail(run.id);
        setArtifacts(detail.artifacts);
        const latest = latestArtifact(detail.artifacts, "draft_plan");
        if (latest && latest.createdAt !== before) {
          setPlanText(artifactMarkdown(latest));
          setPlanExpanded(true);
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
      {/* 1. Understand the plan */}
      <section className="space-y-2">
        <div className="heading-section">Plan</div>
        <p className="text-sm text-white/45">{agentSummary(run)}</p>
        {planning ? (
          <>
            <p className="text-sm text-[#92E4DD] animate-pulse">
              {replanning ? "Agent is replanning…" : "Agent is writing the plan…"}
            </p>
            <div className="field-mono min-h-[min(200px,30vh)] flex items-center justify-center text-sm text-white/40 rounded border border-white/10">
              Plan will appear here when the agent finishes…
            </div>
          </>
        ) : !planText.trim() ? (
          <p className="text-sm text-white/40">No plan yet.</p>
        ) : (
          <>
            {!planExpanded && (
              <button
                type="button"
                onClick={() => setPlanExpanded(true)}
                className="w-full text-left rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 hover:border-white/20 transition-colors"
              >
                <p className="text-sm text-white/75 line-clamp-2">{planSummaryLine(planText)}</p>
                <p className="text-xs text-[#92E4DD] mt-2">Show full plan →</p>
              </button>
            )}
            {planExpanded && (
              <div className="space-y-2">
                <div className="markdown-body-panel markdown-body-panel--short">
                  <MarkdownBody source={planText} />
                </div>
                <button
                  type="button"
                  onClick={() => setPlanExpanded(false)}
                  className="btn-ghost text-xs px-2 py-1"
                >
                  Show summary
                </button>
              </div>
            )}
          </>
        )}
      </section>

      {/* 2. Blocker — agent questions */}
      {openQuestions.length > 0 && !planning && (
        <section className="space-y-2">
          <div className="heading-section text-amber-200">Resolve blocker</div>
          <p className="text-sm text-white/45">Answer before execution can start.</p>
          <PlanQuestionsCard
            questions={openQuestions}
            drafts={answerDrafts}
            onDraftsChange={setAnswerDrafts}
            busy={busy}
          />
        </section>
      )}

      {/* 3. Execute decision */}
      {hasPlan && !planning && (
        <section className="space-y-3">
          <div className="heading-section">Your Decision</div>
          {!answersFreeForm && (
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
          )}
          {openQuestions.length > 0 && (
            <button
              type="button"
              disabled={busy || !answersReady}
              className="btn-gold px-5 py-2 disabled:opacity-40 w-full sm:w-auto"
              onClick={() =>
                act(async () => {
                  const res = await submitPlanAnswers(
                    run.id,
                    planAnswersFromDrafts(openQuestions, answerDrafts),
                    answersFreeForm
                      ? undefined
                      : {
                          executeModel: executeModel || null,
                          executeBudget: phaseBudgetPayload(executeBudget, run.budgetJson, "execute"),
                        }
                  );
                  if (res.outcome === "approved") {
                    onApproved?.();
                    onApprovedAndNext?.();
                  } else {
                    setReplanning(true);
                  }
                })
              }
            >
              {answersFreeForm ? "Submit & replan" : "Submit & start execution"}
            </button>
          )}
          {openQuestions.length > 0 && (
            <div className="flex items-center gap-3 text-xs text-white/30 uppercase tracking-wide">
              <span className="h-px flex-1 bg-white/10" />
              or skip the questions
              <span className="h-px flex-1 bg-white/10" />
            </div>
          )}
          <button
            type="button"
            disabled={busy || !planText.trim()}
            onClick={() =>
              act(async () => {
                await updatePlan(run.id, planText, true, {
                  planModel: planModel || null,
                  executeModel: executeModel || null,
                  planBudget: phaseBudgetPayload(planBudget, run.budgetJson, "plan"),
                  executeBudget: phaseBudgetPayload(executeBudget, run.budgetJson, "execute"),
                });
                onApproved?.();
                onApprovedAndNext?.();
              })
            }
            className="btn-gold px-5 py-2 disabled:opacity-40 w-full sm:w-auto"
          >
            {openQuestions.length > 0 ? "Proceed — agent decides →" : "Approve & next →"}
          </button>
          {openQuestions.length > 0 && (
            <p className="text-xs text-white/40">
              The unanswered questions are passed to the agent, which decides them itself.
            </p>
          )}
        </section>
      )}

      {/* 4. Replan */}
      {hasPlan && !planning && (
        <CollapsibleSection title="Replan" open={replanOpen} onToggle={() => setReplanOpen((o) => !o)}>
          <div className="space-y-3 pl-0.5">
              <p className="text-sm text-white/45">Change plan model/budget or ask the agent to rewrite the plan.</p>
              <PhaseConfigRow
                phase="Plan"
                runtime={runtime}
                model={planModel}
                onModelChange={setPlanModel}
                budget={planBudget}
                onBudgetChange={setPlanBudget}
                defaultModelId={agent?.defaultPlanModel}
                disabled={busy}
              />
              {editing ? (
                <>
                  <textarea
                    className="field-mono min-h-[min(280px,35vh)] resize-y leading-relaxed w-full"
                    value={planText}
                    onChange={(e) => setPlanText(e.target.value)}
                    placeholder="Edit plan markdown"
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy || !planText.trim()}
                      onClick={() => act(() => updatePlan(run.id, planText, false))}
                      className="btn-ghost text-xs px-2 py-1 disabled:opacity-40"
                    >
                      Save edits
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setEditing(false)}
                      className="btn-ghost text-xs px-2 py-1"
                    >
                      Cancel edit
                    </button>
                  </div>
                </>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setEditing(true)}
                    className="btn-ghost text-xs px-2 py-1 disabled:opacity-40"
                  >
                    Edit markdown
                  </button>
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
          </div>
        </CollapsibleSection>
      )}

      {/* 5. More details */}
      {usageSummary && (
        <section className="border-t border-white/10 pt-3">
          <UsagePanel summary={usageSummary} />
        </section>
      )}

      {traceSummary && (
        <CollapsibleSection title="Trace" open={detailsOpen} onToggle={() => setDetailsOpen((o) => !o)}>
          <TracePanel trace={traceSummary} showHeading={false} />
        </CollapsibleSection>
      )}

      {/* 6. Remove */}
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
