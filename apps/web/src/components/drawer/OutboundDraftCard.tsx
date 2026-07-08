import { useState } from "react";
import type { OutboundDraftContent } from "@agent-dealer/shared";
import CollapsibleSection from "../ui/CollapsibleSection";

type Props = {
  content: OutboundDraftContent;
  deliverError?: string | null;
  onRetrySend?: () => void;
  retrySendBusy?: boolean;
};

/** Pending outbound draft — target + body prominent; exact toolCall collapsible. */
export default function OutboundDraftCard({ content, deliverError, onRetrySend, retrySendBusy }: Props) {
  const { draft, bodyMismatch } = content;
  const toolCallJson = JSON.stringify(draft.toolCall, null, 2);
  const [toolOpen, setToolOpen] = useState(Boolean(bodyMismatch));

  return (
    <section className="space-y-3 rounded-lg border border-[#C4B643]/30 bg-[#C4B643]/5 p-3">
      <div className="heading-section text-[#E8DC7A]">Outbound message (will send on approve)</div>
      {bodyMismatch && (
        <p className="text-sm text-amber-300/90">
          Summary body does not match toolCall arguments — review the exact payload below.
        </p>
      )}
      <div className="space-y-1">
        <p className="text-xs text-white/40 uppercase tracking-wide">To</p>
        <p className="text-base text-[#E8F6F4] font-medium">{draft.summary.target}</p>
      </div>
      <div className="space-y-1">
        <p className="text-xs text-white/40 uppercase tracking-wide">Message</p>
        <textarea
          className="field-mono min-h-[100px] resize-y w-full"
          value={draft.summary.body}
          readOnly
        />
      </div>
      <CollapsibleSection
        title="Exact tool call (server sends verbatim)"
        open={toolOpen}
        onToggle={() => setToolOpen((o) => !o)}
        bordered={false}
      >
        <pre className="field-mono text-xs overflow-x-auto whitespace-pre-wrap p-2">{toolCallJson}</pre>
      </CollapsibleSection>
      {deliverError && (
        <div className="space-y-2 rounded border border-red-500/30 bg-red-500/5 p-2">
          <p className="text-sm text-red-400/90">Send failed: {deliverError}</p>
          <p className="text-xs text-white/45">
            Use Retry send after fixing the issue (e.g. deck down, wrong Slack user). To change the
            message or recipient, use Retry with new instructions below.
          </p>
          {onRetrySend && (
            <button
              type="button"
              disabled={retrySendBusy}
              onClick={onRetrySend}
              className="btn-gold w-full py-2 disabled:opacity-40"
            >
              Retry send →
            </button>
          )}
        </div>
      )}
    </section>
  );
}
