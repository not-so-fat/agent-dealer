import { z } from "zod";
import { PhaseBudget } from "./budget.js";

export const PlanQuestionOption = z.object({
  label: z.string().min(1).max(60),
  description: z.string().max(200).optional(),
});
export type PlanQuestionOption = z.infer<typeof PlanQuestionOption>;

export const PlanQuestion = z.object({
  id: z.string().regex(/^q\d+$/),
  question: z.string().min(1).max(300),
  options: z.array(PlanQuestionOption).min(2).max(4),
});
export type PlanQuestion = z.infer<typeof PlanQuestion>;

export const PlanTriageVerdict = z.enum(["trivial", "needs_review"]);
export type PlanTriageVerdict = z.infer<typeof PlanTriageVerdict>;

/** Agent output contract — final fenced json block of a plan reply (PRD §7.1). */
export const PlanTriageBlock = z
  .object({
    verdict: PlanTriageVerdict,
    rationale: z.string().min(1).max(300),
    questions: z.array(PlanQuestion).max(3).default([]),
  })
  .refine((t) => t.verdict !== "trivial" || t.questions.length === 0, {
    message: "trivial verdict cannot carry questions",
  });
export type PlanTriageBlock = z.infer<typeof PlanTriageBlock>;

/** plan_triage artifact contentJson (PRD §7.3). */
export const PlanTriageContent = z.object({
  verdict: PlanTriageVerdict,
  rationale: z.string(),
  questions: z.array(PlanQuestion),
  sessionId: z.string().optional(),
  parseFallback: z.boolean(),
  consumed: z.boolean().default(false),
});
export type PlanTriageContent = z.infer<typeof PlanTriageContent>;

export const PlanAnswer = z
  .object({
    questionId: z.string(),
    selectedLabel: z.string().max(60).optional(),
    freeText: z.string().min(1).max(2000).optional(),
  })
  .refine((a) => (a.selectedLabel ? !a.freeText : Boolean(a.freeText)), {
    message: "Provide exactly one of selectedLabel or freeText",
  });
export type PlanAnswer = z.infer<typeof PlanAnswer>;

/** POST /api/runs/:id/plan/answers body (PRD §7.2). */
export const PlanAnswersInput = z.object({
  answers: z.array(PlanAnswer).min(1),
  executeModel: z.string().nullable().optional(),
  executeBudget: PhaseBudget.nullable().optional(),
});
export type PlanAnswersInput = z.infer<typeof PlanAnswersInput>;

/** plan_answers artifact contentJson (PRD §7.4). */
export const PlanAnswersContent = z.object({
  answers: z.array(PlanAnswer),
  outcome: z.enum(["approved", "redraft"]),
  answeredAt: z.string(),
});
export type PlanAnswersContent = z.infer<typeof PlanAnswersContent>;

export type PlanGateDecision = "auto_approve" | "await_answers" | "await_review";

/** After this many question rounds, drafts always go to manual review (PRD F3.5). */
export const MAX_QUESTION_ROUNDS = 2;

export function planGateDecision(input: {
  triage: Pick<PlanTriageContent, "verdict" | "questions" | "consumed" | "parseFallback">;
  /** Count of PRIOR plan_triage artifacts on this run that carried questions. */
  priorQuestionRounds: number;
}): PlanGateDecision {
  const { triage, priorQuestionRounds } = input;
  if (triage.consumed) return "await_review";
  if (triage.questions.length > 0) {
    return priorQuestionRounds >= MAX_QUESTION_ROUNDS ? "await_review" : "await_answers";
  }
  if (triage.verdict === "trivial" && !triage.parseFallback) return "auto_approve";
  return "await_review";
}
