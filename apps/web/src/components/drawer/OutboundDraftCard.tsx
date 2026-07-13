import { useMemo, useState } from "react";
import type { OutboundDraftContent } from "@agent-dealer/shared";
import { applyOutboundBodyEdit } from "@agent-dealer/shared";
import CollapsibleSection from "../ui/CollapsibleSection";

type Props = {
  content: OutboundDraftContent;
  body: string;
  onBodyChange: (body: string) => void;
  deliverError?: string | null;
  onRetrySend?: () => void;
  retrySendBusy?: boolean;
  disabled?: boolean;
};

/** Pending outbound draft — target + editable body; exact toolCall collapsible. */
export default function OutboundDraftCard({
  content,
  body,
  onBodyChange,
  deliverError,
  onRetrySend,
  retrySendBusy,
  disabled,
}: Props) {
  const { draft, bodyMismatch } = content;
  const editedDraft = useMemo(() => applyOutboundBodyEdit(draft, body), [draft, body]);
  const toolCallJson = JSON.stringify(editedDraft.toolCall, null, 2);
  const [toolOpen, setToolOpen] = useState(Boolean(bodyMismatch));
  const edited = body !== draft.summary.body;

  return (
    <section className="space-y-3 rounded-lg border border-[#C4B643]/30 bg-[#C4B643]/5 p-3">
      <div className="heading-section text-[#E8DC7A]">Outbound message (will send on approve)</div>
      {bodyMismatch && !edited && (
        <p className="text-sm text-amber-300/90">
          Summary body does not match toolCall arguments — review the exact payload below.
        </p>
      )}
      {edited && (
        <p className="text-sm text-[#92E4DD]/90">Message edited — approve to send your version.</p>
      )}
      <div className="space-y-1">
        <p className="text-xs text-white/40 uppercase tracking-wide">To</p>
        <p className="text-base text-[#E8F6F4] font-medium">{draft.summary.target}</p>
      </div>
      <div className="space-y-1">
        <label htmlFor="outbound-body" className="text-xs text-white/40 uppercase tracking-wide">
          Message
        </label>
        <textarea
          id="outbound-body"
          className="field-mono min-h-[100px] resize-y w-full"
          value={body}
          onChange={(e) => onBodyChange(e.target.value)}
          disabled={disabled}
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
            Fix the message above or retry send after fixing the deck connection. To change recipient
            or rewrite from scratch, use Retry with new instructions below.
          </p>
          {onRetrySend && (
            <button
              type="button"
              disabled={retrySendBusy || !body.trim()}
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
