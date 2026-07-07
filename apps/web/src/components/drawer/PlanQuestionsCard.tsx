import type { PlanQuestion } from "@agent-dealer/shared";

export type AnswerDraft = { selectedLabel?: string; freeText?: string };

type Props = {
  questions: PlanQuestion[];
  drafts: Record<string, AnswerDraft>;
  onDraftsChange: (drafts: Record<string, AnswerDraft>) => void;
  busy: boolean;
};

/** Agent plan questions — answers pair with Your Decision execution config below the plan. */
export default function PlanQuestionsCard({ questions, drafts, onDraftsChange, busy }: Props) {
  const setDraft = (questionId: string, draft: AnswerDraft) => {
    onDraftsChange({ ...drafts, [questionId]: draft });
  };

  return (
    <div className="space-y-3 rounded-xl border border-amber-400/40 bg-amber-400/5 p-3">
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
                  onClick={() => setDraft(q.id, { selectedLabel: o.label })}
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
              onChange={(e) => setDraft(q.id, e.target.value ? { freeText: e.target.value } : {})}
            />
          </div>
        );
      })}
    </div>
  );
}

export function planAnswersFromDrafts(
  questions: PlanQuestion[],
  drafts: Record<string, AnswerDraft>
): Array<{ questionId: string; selectedLabel?: string; freeText?: string }> {
  return questions.map((q) => ({ questionId: q.id, ...drafts[q.id] }));
}

export function planAnswersReady(questions: PlanQuestion[], drafts: Record<string, AnswerDraft>): boolean {
  return questions.every((q) => {
    const d = drafts[q.id];
    return Boolean(d?.selectedLabel || d?.freeText?.trim());
  });
}

export function planAnswersHaveFreeForm(
  questions: PlanQuestion[],
  drafts: Record<string, AnswerDraft>
): boolean {
  return questions.some((q) => drafts[q.id]?.freeText?.trim());
}
