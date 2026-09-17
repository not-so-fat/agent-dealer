import type { PhaseBudget } from "@agent-dealer/shared";
import { parsePhaseBudget } from "@agent-dealer/shared";

export type BudgetFormValue = {
  maxTurns: string;
  maxBudgetUsd: string;
};

export function budgetFormEmpty(): BudgetFormValue {
  return { maxTurns: "", maxBudgetUsd: "" };
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

export function agentPhaseBudgetFromJson(json: string | null | undefined): BudgetFormValue {
  const budget = parsePhaseBudget(json);
  return {
    maxTurns: budget?.maxTurns != null ? String(budget.maxTurns) : "",
    maxBudgetUsd: budget?.maxBudgetUsd != null ? String(budget.maxBudgetUsd) : "",
  };
}
