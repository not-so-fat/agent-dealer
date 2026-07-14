import { useCallback, useEffect, useState } from "react";
import type { AgentWithHealth, Artifact, OutboundDraftContent, Run } from "@agent-dealer/shared";
import { agentSummary } from "../../AgentConfigFields";
import PhaseConfigRow from "../agents/PhaseConfigRow";
import {
  approveRun,
  artifactMarkdown,
  askResultQuestion,
  cancelRun,
  fetchRunDetail,
  latestArtifact,
  latestByPhase,
  parseArtifact,
  retryRun,
  type DocumentContent,
  type ExecutionResultContent,
  type StreamTraceContent,
  type UsageSummary,
} from "../../api";
import {
  budgetFormEmpty,
  phaseBudgetPayload,
  runPhaseBudgetFromRun,
  type BudgetFormValue,
} from "../../lib/budgetForm";
import { TracePanel, UsagePanel } from "../panels/TraceUsage";
import MarkdownBody from "../ui/MarkdownBody";
import CollapsibleSection from "../ui/CollapsibleSection";
import { ExecutionOutcomeSection, executionHasBlocker } from "./ExecutionOutcomeSection";
import PlaybookLearningPanel from "./PlaybookLearningPanel";
import OutboundDraftCard from "./OutboundDraftCard";
import ResultQaThread, { qaExchanges } from "./ResultQaThread";
import RemoveFromOpsAction from "./RemoveFromOpsAction";

type Props = {
  run: Run;
  agents: AgentWithHealth[];
  onRefresh: () => void;
  onRetry?: (newRun: Run) => void;
  onDoneAndNext?: () => void;
};

export default function ResultReviewPanel({ run, agents, onRefresh, onRetry, onDoneAndNext }: Props) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [traceSummary, setTraceSummary] = useState<StreamTraceContent | null>(null);
  const [feedback, setFeedback] = useState("");
  const [executeModel, setExecuteModel] = useState("");
  const [executeBudget, setExecuteBudget] = useState<BudgetFormValue>(budgetFormEmpty());
  const [busy, setBusy] = useState(false);
  const [prefilledRetry, setPrefilledRetry] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);
  const [deliverError, setDeliverError] = useState<string | null>(null);
  const [outboundBody, setOutboundBody] = useState("");

  const agent = agents.find((a) => a.id === run.agentId);
  const runtime = run.runtime ?? agent?.runtime ?? "claude_code";

  const load = useCallback(async () => {
    const detail = await fetchRunDetail(run.id);
    setArtifacts(detail.artifacts);
    setUsageSummary(detail.usageSummary ?? null);
    setTraceSummary(detail.traceSummary ?? null);
    const failed = detail.events?.filter((e) => e.type === "deliver_failed").at(-1);
    if (failed?.payloadJson) {
      try {
        const payload = JSON.parse(failed.payloadJson) as { error?: string };
        setDeliverError(payload.error ?? null);
      } catch {
        setDeliverError(null);
      }
    }
  }, [run.id]);

  const execResult = latestByPhase<ExecutionResultContent>(artifacts, "execution_result", "execute");
  const documentArtifact = latestArtifact(artifacts, "document");
  const document = documentArtifact ? parseArtifact<DocumentContent>(documentArtifact) : null;
  const approvedPlan = artifacts.find((a) => a.kind === "approved_plan");
  const pendingOutbound = findPendingOutboundDraft(artifacts);
  const blocked = executionHasBlocker(execResult);
  const canRetry = !!feedback.trim();
  const exchanges = qaExchanges(artifacts);
  const qaPending = exchanges.some((e) => e.status === "pending");

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  const reflectPending = artifacts.some((a) => {
    if (a.kind !== "reflect_status" || !a.contentJson) return false;
    try {
      return (JSON.parse(a.contentJson) as { status?: string }).status === "pending";
    } catch {
      return false;
    }
  });

  const shouldPoll = reflectPending || qaPending;

  useEffect(() => {
    if (!shouldPoll) return;
    const timer = setInterval(() => {
      load().catch(console.error);
    }, 3000);
    return () => clearInterval(timer);
  }, [shouldPoll, load]);

  useEffect(() => {
    setPrefilledRetry(false);
    setFeedback("");
    setTraceOpen(false);
    setDeliverError(null);
    setOutboundBody("");
    setExecuteModel(run.executeModel ?? "");
    setExecuteBudget(runPhaseBudgetFromRun(run.budgetJson, "execute"));
  }, [run.id, run.executeModel, run.budgetJson]);

  useEffect(() => {
    if (pendingOutbound) {
      setOutboundBody(pendingOutbound.draft.summary.body);
    }
  }, [pendingOutbound?.draft.summary.body, run.id]);

  useEffect(() => {
    if (prefilledRetry || !blocked) return;
    const summary = execResult?.blocker?.summary;
    if (summary) {
      setFeedback(`Please resolve: ${summary}`);
      setPrefilledRetry(true);
    }
  }, [prefilledRetry, blocked, execResult?.blocker?.summary]);

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

  const approveSend = async () => {
    setBusy(true);
    setDeliverError(null);
    try {
      await approveRun(run.id, pendingOutbound ? outboundBody.trim() || undefined : undefined);
      await load();
      onRefresh();
      onDoneAndNext?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (pendingOutbound) setDeliverError(msg);
      else alert(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <section className="space-y-1">
        <div className="heading-section">Agent</div>
        <p className="text-body">{agentSummary(run)}</p>
        {blocked && (
          <p className="text-sm text-red-400/90">Blocked — resolve the issue below, then retry</p>
        )}
        {run.status === "failed" && !blocked && (
          <p className="text-sm text-red-400/90">Execution failed — retry with new instructions</p>
        )}
      </section>

      {document && !blocked && (
        <section className="space-y-2">
          <div className="heading-section">Deliverable</div>
          <p className="text-sm text-white/45">{document.path}</p>
          <div className="markdown-body-panel markdown-body-panel--flow">
            <MarkdownBody source={document.markdown} />
          </div>
        </section>
      )}

      {execResult && <ExecutionOutcomeSection execResult={execResult} />}

      <ResultQaThread
        exchanges={exchanges}
        busy={busy}
        onAsk={(question) => act(() => askResultQuestion(run.id, question))}
      />

      <section className="space-y-4 border-t border-white/10 pt-3">
        <div className="heading-section">Your Decision</div>

        {pendingOutbound && run.status === "review" && !blocked && (
          <OutboundDraftCard
            content={pendingOutbound}
            body={outboundBody}
            onBodyChange={setOutboundBody}
            deliverError={deliverError}
            onRetrySend={approveSend}
            retrySendBusy={busy}
            disabled={busy}
          />
        )}

        {run.status === "review" && !blocked && (
          <div className="space-y-2">
            <p className="text-sm text-white/45">
              {pendingOutbound
                ? deliverError
                  ? "Fix the send issue above, or edit the message and retry."
                  : "Edit the message if needed, then approve to send."
                : "Looks good? Accept and move on."}
            </p>
            <button
              type="button"
              disabled={busy || (!pendingOutbound && !!feedback.trim()) || (!!pendingOutbound && !outboundBody.trim())}
              title={
                !pendingOutbound && feedback.trim()
                  ? "Clear retry instructions below to mark done"
                  : undefined
              }
              onClick={() => void approveSend()}
              className="btn-gold w-full py-2 disabled:opacity-40"
            >
              {pendingOutbound ? "Approve & send →" : "Mark done & next →"}
            </button>
            {!pendingOutbound && feedback.trim() && (
              <p className="text-xs text-white/40">Clear the retry field below to accept this result.</p>
            )}
          </div>
        )}

        {(run.status === "review" && !blocked) && (
          <div className="flex items-center gap-3 text-xs text-white/30 uppercase tracking-wide">
            <span className="h-px flex-1 bg-white/10" />
            or send back
            <span className="h-px flex-1 bg-white/10" />
          </div>
        )}

        <div className="space-y-2">
          {(blocked || run.status === "failed") && (
            <p className="text-sm text-white/45">Add instructions and retry — re-runs execution with the same approved plan.</p>
          )}
          <label htmlFor={`retry-${run.id}`} className="text-xs text-white/40 uppercase tracking-wide">
            Retry instructions
          </label>
          {exchanges.some((e) => e.status === "answered") && (
            <p className="text-xs text-white/40">This discussion is included automatically if you retry.</p>
          )}
          <textarea
            id={`retry-${run.id}`}
            className="field-mono min-h-[min(140px,22vh)] resize-y leading-relaxed"
            placeholder={
              blocked
                ? "What to change after fixing the blocker"
                : pendingOutbound
                  ? "What should change in the draft? (e.g. correct Slack user ID)"
                  : "What should the agent do differently?"
            }
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
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
            disabled={busy || !canRetry}
            onClick={() =>
              act(async () => {
                const executeBudgetPayload = phaseBudgetPayload(
                  executeBudget,
                  run.budgetJson,
                  "execute"
                );
                const newRun = await retryRun(
                  run.id,
                  feedback,
                  executeModel || null,
                  executeBudgetPayload
                );
                setFeedback("");
                setDeliverError(null);
                onRetry?.(newRun);
              })
            }
            className={`w-full py-2 ${canRetry ? "btn-retry-ready" : "btn-retry"}`}
          >
            Retry with new instructions
          </button>
        </div>

      </section>

      {approvedPlan && (
        <section className="space-y-2">
          <div className="heading-section">Approved Plan</div>
          <div className="markdown-body-panel markdown-body-panel--flow">
            <MarkdownBody source={artifactMarkdown(approvedPlan)} />
          </div>
        </section>
      )}

      <PlaybookLearningPanel run={run} artifacts={artifacts} />

      {usageSummary && (
        <section className="border-t border-white/10 pt-3">
          <UsagePanel summary={usageSummary} />
        </section>
      )}

      {traceSummary && (
        <CollapsibleSection title="Trace" open={traceOpen} onToggle={() => setTraceOpen((o) => !o)}>
          <TracePanel trace={traceSummary} showHeading={false} />
        </CollapsibleSection>
      )}

      <RemoveFromOpsAction
        busy={busy}
        onRemoved={() =>
          act(async () => {
            await cancelRun(run.id);
            onDoneAndNext?.();
          })
        }
      />
    </div>
  );
}

function findPendingOutboundDraft(artifacts: Artifact[]): OutboundDraftContent | null {
  for (const kind of ["slack_draft", "email_draft", "service_draft"] as const) {
    const art = latestArtifact(artifacts, kind);
    if (!art?.contentJson) continue;
    try {
      const content = JSON.parse(art.contentJson) as OutboundDraftContent;
      if (content.status === "pending") return content;
    } catch {
      // skip
    }
  }
  return null;
}
