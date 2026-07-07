import type { PhaseBudget } from "@agent-dealer/shared";
import { parsePhaseBudget, parseRunBudget } from "@agent-dealer/shared";

export type BudgetFormValue = {
  maxTurns: string;
  maxBudgetUsd: string;
};

export function budgetFormEmpty(): BudgetFormValue {
  return { maxTurns: "", maxBudgetUsd: "" };
}

export function budgetFormFromPhase(budget: PhaseBudget | null | undefined): BudgetFormValue {
  return {
    maxTurns: budget?.maxTurns != null ? String(budget.maxTurns) : "",
    maxBudgetUsd: budget?.maxBudgetUsd != null ? String(budget.maxBudgetUsd) : "",
  };
}

export function phaseBudgetFromForm(form: BudgetFormValue): PhaseBudget | null {
  const maxTurns = form.maxTurns.trim() ? Number(form.maxTurns) : null;
  const maxBudgetUsd = form.maxBudgetUsd.trim() ? Number(form.maxBudgetUsd) : null;
  if (maxTurns == null && maxBudgetUsd == null) return null;
  if ((maxTurns != null && (!Number.isFinite(maxTurns) || maxTurns <= 0)) ||
      (maxBudgetUsd != null && (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0))) {
    return null;
  }
  return { maxTurns, maxBudgetUsd };
}

export function runHasPhaseBudgetOverride(
  budgetJson: string | null | undefined,
  phase: "plan" | "execute"
): boolean {
  const form = runPhaseBudgetFromRun(budgetJson, phase);
  return !!(form.maxTurns || form.maxBudgetUsd);
}

/** Omit when blank and no run override; null clears an existing override. */
export function phaseBudgetPayload(
  form: BudgetFormValue,
  budgetJson: string | null | undefined,
  phase: "plan" | "execute"
): PhaseBudget | null | undefined {
  const formEmpty = !form.maxTurns.trim() && !form.maxBudgetUsd.trim();
  if (formEmpty && !runHasPhaseBudgetOverride(budgetJson, phase)) return undefined;
  return phaseBudgetFromForm(form);
}

export function runPhaseBudgetFromRun(
  budgetJson: string | null | undefined,
  phase: "plan" | "execute"
): BudgetFormValue {
  const runBudget = parseRunBudget(budgetJson);
  return budgetFormFromPhase(runBudget[phase]);
}

export function agentPhaseBudgetFromJson(json: string | null | undefined): BudgetFormValue {
  return budgetFormFromPhase(parsePhaseBudget(json));
}
