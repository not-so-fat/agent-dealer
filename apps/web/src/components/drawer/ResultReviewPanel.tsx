import { useCallback, useEffect, useState } from "react";
import type { AgentWithHealth, Artifact, Run } from "@agent-dealer/shared";
import { agentSummary } from "../../AgentConfigFields";
import ModelSelect from "../agents/ModelSelect";
import {
  approveRun,
  artifactMarkdown,
  cancelRun,
  fetchRunDetail,
  latestArtifact,
  latestByPhase,
  parseArtifact,
  retryRun,
  type DocumentContent,
  type ExecutionResultContent,
  type StreamTraceContent,
  type UsageContent,
} from "../../api";
import { TracePanel, UsagePanel } from "../panels/TraceUsage";
import { ExecutionOutcomeSection, executionHasBlocker } from "./ExecutionOutcomeSection";
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
  const [feedback, setFeedback] = useState("");
  const [planModel, setPlanModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [prefilledRetry, setPrefilledRetry] = useState(false);

  const agent = agents.find((a) => a.id === run.agentId);
  const runtime = run.runtime ?? agent?.runtime ?? "claude_code";

  const load = useCallback(async () => {
    const detail = await fetchRunDetail(run.id);
    setArtifacts(detail.artifacts);
  }, [run.id]);

  const execResult = latestByPhase<ExecutionResultContent>(artifacts, "execution_result", "execute");
  const traceExec = latestByPhase<StreamTraceContent>(artifacts, "stream_trace", "execute");
  const usageExec = latestByPhase<UsageContent>(artifacts, "usage", "execute");
  const documentArtifact = latestArtifact(artifacts, "document");
  const document = documentArtifact ? parseArtifact<DocumentContent>(documentArtifact) : null;
  const approvedPlan = artifacts.find((a) => a.kind === "approved_plan");
  const blocked = executionHasBlocker(execResult);
  const canRetry = !!feedback.trim();

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  useEffect(() => {
    setPrefilledRetry(false);
    setFeedback("");
    setPlanModel("");
  }, [run.id]);

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
          <textarea className="field-mono min-h-[160px] resize-y" value={document.markdown} readOnly />
        </section>
      )}

      {execResult && <ExecutionOutcomeSection execResult={execResult} />}

      {approvedPlan && (
        <section className="space-y-2">
          <div className="heading-section">Approved Plan</div>
          <textarea className="field-mono min-h-[120px] resize-y text-sm" value={artifactMarkdown(approvedPlan)} readOnly />
        </section>
      )}

      {traceExec && <TracePanel trace={traceExec} />}
      {usageExec && <UsagePanel usage={usageExec} />}

      <section className="space-y-4">
        <div className="heading-section">Your Decision</div>

        {run.status === "review" && !blocked && (
          <div className="space-y-2">
            <p className="text-sm text-white/45">Looks good? Accept and move on.</p>
            <button
              type="button"
              disabled={busy || !!feedback.trim()}
              title={feedback.trim() ? "Clear retry instructions below to mark done" : undefined}
              onClick={() =>
                act(async () => {
                  await approveRun(run.id);
                  onDoneAndNext?.();
                })
              }
              className="btn-gold w-full py-2 disabled:opacity-40"
            >
              Mark done & next →
            </button>
            {feedback.trim() && (
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
            <p className="text-sm text-white/45">Add instructions and retry — starts a new plan cycle.</p>
          )}
          <label htmlFor={`retry-${run.id}`} className="text-xs text-white/40 uppercase tracking-wide">
            Retry instructions
          </label>
          <textarea
            id={`retry-${run.id}`}
            className="field-mono min-h-[min(140px,22vh)] resize-y leading-relaxed"
            placeholder={
              blocked
                ? "What to change after fixing the blocker"
                : "What should the agent do differently?"
            }
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <ModelSelect
            runtime={runtime}
            label="Planning model (retry)"
            value={planModel}
            onChange={setPlanModel}
            defaultModelId={agent?.defaultPlanModel}
            disabled={busy}
          />
          <button
            type="button"
            disabled={busy || !canRetry}
            onClick={() =>
              act(async () => {
                const newRun = await retryRun(run.id, feedback, planModel || null);
                setFeedback("");
                onRetry?.(newRun);
              })
            }
            className={`w-full py-2 ${canRetry ? "btn-retry-ready" : "btn-retry"}`}
          >
            Retry with new instructions
          </button>
        </div>

        <RemoveFromOpsAction
          busy={busy}
          onRemoved={() =>
            act(async () => {
              await cancelRun(run.id);
              onDoneAndNext?.();
            })
          }
        />
      </section>
    </div>
  );
}
