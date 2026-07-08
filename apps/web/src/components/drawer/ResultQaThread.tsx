import { useState } from "react";
import type { Artifact, ResultQaContent } from "@agent-dealer/shared";
import { latestQaExchanges } from "@agent-dealer/shared";
import MarkdownBody from "../ui/MarkdownBody";

type Props = {
  exchanges: ResultQaContent[];
  busy: boolean;
  onAsk: (question: string) => Promise<void>;
};

/** Ask the run's agent about its own result. Read-only for the agent; feeds retry automatically. */
export default function ResultQaThread({ exchanges, busy, onAsk }: Props) {
  const [question, setQuestion] = useState("");
  const pending = exchanges.some((e) => e.status === "pending");
  const canAsk = !busy && !pending && question.trim().length > 0;

  return (
    <section className="space-y-2">
      <div className="heading-section">Ask the agent</div>

      {exchanges.map((e) => (
        <div key={e.exchangeId} className="space-y-1 rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <p className="text-sm text-white/85">{e.question}</p>
          {e.status === "pending" && (
            <p className="text-sm text-[#92E4DD] animate-pulse">Agent is answering…</p>
          )}
          {e.status === "failed" && (
            <p className="text-sm text-red-400/90">Could not answer{e.error ? ` — ${e.error}` : ""}. Ask again.</p>
          )}
          {e.status === "answered" && e.answer && (
            <>
              <div className="markdown-body-panel markdown-body-panel--flow">
                <MarkdownBody source={e.answer} />
              </div>
              {!e.sessionResumed && (
                <p className="text-xs text-white/30">Answered from artifacts — the original session had expired.</p>
              )}
            </>
          )}
        </div>
      ))}

      <textarea
        className="field-mono min-h-[72px] resize-y leading-relaxed"
        placeholder="Why did you choose this approach? Did you check X?"
        value={question}
        disabled={busy || pending}
        onChange={(e) => setQuestion(e.target.value)}
      />
      <button
        type="button"
        disabled={!canAsk}
        onClick={async () => {
          const q = question.trim();
          setQuestion("");
          await onAsk(q);
        }}
        className="btn-ghost text-xs px-2 py-1 disabled:opacity-40"
      >
        {pending ? "Answering…" : "Ask"}
      </button>
    </section>
  );
}

export function qaExchanges(artifacts: Artifact[]): ResultQaContent[] {
  const parsed: ResultQaContent[] = [];
  for (const a of artifacts) {
    if (a.kind !== "result_qa" || !a.contentJson) continue;
    try {
      parsed.push(JSON.parse(a.contentJson) as ResultQaContent);
    } catch {
      // skip
    }
  }
  return latestQaExchanges(parsed);
}
