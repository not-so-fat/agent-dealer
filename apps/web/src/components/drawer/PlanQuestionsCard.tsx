import { useState } from "react";
import type { PlanQuestion } from "@agent-dealer/shared";

type AnswerDraft = { selectedLabel?: string; freeText?: string };

type Props = {
  questions: PlanQuestion[];
  busy: boolean;
  onSubmit: (answers: Array<{ questionId: string; selectedLabel?: string; freeText?: string }>) => void;
};

/** Structured plan questions — option buttons approve fast; free-form triggers a replan. */
export default function PlanQuestionsCard({ questions, busy, onSubmit }: Props) {
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({});
  const allAnswered = questions.every((q) => {
    const d = drafts[q.id];
    return Boolean(d?.selectedLabel || d?.freeText?.trim());
  });
  const hasFreeForm = questions.some((q) => drafts[q.id]?.freeText?.trim());

  return (
    <section className="space-y-3 rounded-xl border border-amber-400/40 bg-amber-400/5 p-3">
      <div className="heading-section text-amber-200">Agent needs your answer</div>
      {questions.map((q) => {
        const d = drafts[q.id] ?? {};
        return (
          <div key={q.id} className="space-y-1.5">
            <p className="text-sm text-white/85">{q.question}</p>
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((o) => (
                <button
                  key={o.label}
                  type="button"
                  disabled={busy}
                  title={o.description}
                  onClick={() => setDrafts((prev) => ({ ...prev, [q.id]: { selectedLabel: o.label } }))}
                  className={`btn-ghost text-xs px-2 py-1 ${
                    d.selectedLabel === o.label ? "ring-1 ring-amber-300 text-amber-200" : ""
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <input
              className="field-mono w-full text-xs"
              placeholder="Other… (free-form answer triggers a replan)"
              value={d.freeText ?? ""}
              disabled={busy}
              onChange={(e) =>
                setDrafts((prev) => ({
                  ...prev,
                  [q.id]: e.target.value ? { freeText: e.target.value } : {},
                }))
              }
            />
          </div>
        );
      })}
      <button
        type="button"
        disabled={busy || !allAnswered}
        className="btn-gold px-4 py-1.5 disabled:opacity-40"
        onClick={() => onSubmit(questions.map((q) => ({ questionId: q.id, ...drafts[q.id] })))}
      >
        {hasFreeForm ? "Submit & replan" : "Submit & start execution"}
      </button>
    </section>
  );
}
