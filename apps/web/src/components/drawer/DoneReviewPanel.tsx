import { useCallback, useEffect, useState } from "react";
import type { Artifact, OutboundDraftContent, Run, SendReceiptContent } from "@agent-dealer/shared";
import { agentSummary } from "../../AgentConfigFields";
import {
  artifactMarkdown,
  fetchRunDetail,
  latestArtifact,
  latestByPhase,
  parseArtifact,
  type DocumentContent,
  type ExecutionResultContent,
  type StreamTraceContent,
  type UsageSummary,
} from "../../api";
import { TracePanel, UsagePanel } from "../panels/TraceUsage";
import MarkdownBody from "../ui/MarkdownBody";
import { ExecutionOutcomeSection } from "./ExecutionOutcomeSection";
import PlaybookLearningPanel from "./PlaybookLearningPanel";

type Props = {
  run: Run;
};

export default function DoneReviewPanel({ run }: Props) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [traceSummary, setTraceSummary] = useState<StreamTraceContent | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const detail = await fetchRunDetail(run.id);
    setArtifacts(detail.artifacts);
    setUsageSummary(detail.usageSummary ?? null);
    setTraceSummary(detail.traceSummary ?? null);
  }, [run.id]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      alert(String(e));
    } finally {
      setBusy(false);
    }
  };

  const execResult = latestByPhase<ExecutionResultContent>(artifacts, "execution_result", "execute");
  const documentArtifact = latestArtifact(artifacts, "document");
  const document = documentArtifact ? parseArtifact<DocumentContent>(documentArtifact) : null;
  const approvedPlan = artifacts.find((a) => a.kind === "approved_plan");
  const outboundDraft = latestOutboundDraft(artifacts);
  const sendReceipt = latestArtifact(artifacts, "send_receipt");
  const receipt = sendReceipt ? parseArtifact<SendReceiptContent>(sendReceipt) : null;

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  return (
    <div className="space-y-4">
      <section className="space-y-1">
        <div className="heading-section">Completed Run (Read-Only)</div>
        <p className="text-body">{agentSummary(run)}</p>
      </section>

      {approvedPlan && (
        <section className="space-y-2">
          <div className="heading-section">Approved Plan</div>
          <div className="markdown-body-panel markdown-body-panel--short">
            <MarkdownBody source={artifactMarkdown(approvedPlan)} />
          </div>
        </section>
      )}

      {document && (
        <section className="space-y-2">
          <div className="heading-section">Document</div>
          <textarea className="field-mono min-h-[160px] resize-y" value={document.markdown} readOnly />
        </section>
      )}

      {execResult && <ExecutionOutcomeSection execResult={execResult} />}

      {outboundDraft && (
        <section className="space-y-2">
          <div className="heading-section">Outbound draft ({outboundDraft.status})</div>
          <p className="text-sm text-white/45">To: {outboundDraft.draft.summary.target}</p>
          <textarea className="field-mono min-h-[80px] resize-y" value={outboundDraft.draft.summary.body} readOnly />
        </section>
      )}

      {receipt && (
        <section className="space-y-2">
          <div className="heading-section">Send receipt</div>
          <p className="text-sm text-white/45">
            Sent {new Date(receipt.sentAt).toLocaleString()}
            {receipt.permalink && (
              <>
                {" · "}
                <a href={receipt.permalink} className="text-[#92E4DD] hover:underline" target="_blank" rel="noreferrer">
                  Open message
                </a>
              </>
            )}
          </p>
        </section>
      )}

      <PlaybookLearningPanel run={run} artifacts={artifacts} busy={busy} act={act} />

      {usageSummary && <UsagePanel summary={usageSummary} />}
      {traceSummary && <TracePanel trace={traceSummary} />}
    </div>
  );
}

function latestOutboundDraft(artifacts: Artifact[]): OutboundDraftContent | null {
  for (const kind of ["slack_draft", "email_draft"] as const) {
    const art = latestArtifact(artifacts, kind);
    if (!art?.contentJson) continue;
    try {
      return JSON.parse(art.contentJson) as OutboundDraftContent;
    } catch {
      // skip
    }
  }
  return null;
}
