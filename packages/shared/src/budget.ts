import { z } from "zod";

/** Per-phase CLI caps. null field = omit flag (runtime default). */
export const PhaseBudget = z.object({
  maxTurns: z.number().positive().nullable().optional(),
  maxBudgetUsd: z.number().positive().nullable().optional(),
});
export type PhaseBudget = z.infer<typeof PhaseBudget>;

export const RunBudget = z.object({
  plan: PhaseBudget.optional(),
  execute: PhaseBudget.optional(),
  reflect: PhaseBudget.optional(),
});
export type RunBudget = z.infer<typeof RunBudget>;

export type BudgetPhase = "plan" | "execute" | "reflect";

export type ResolvedPhaseBudget = {
  maxTurns?: number;
  maxBudgetUsd?: number;
};

/** Tight caps for flow:verify and other automated gates. */
export const TEST_PHASE_BUDGET: Record<BudgetPhase, Required<PhaseBudget>> = {
  plan: { maxTurns: 5, maxBudgetUsd: 0.5 },
  execute: { maxTurns: 30, maxBudgetUsd: 5 },
  reflect: { maxTurns: 3, maxBudgetUsd: 0.25 },
};

export function parsePhaseBudget(json: string | null | undefined): PhaseBudget | null {
  if (!json?.trim()) return null;
  try {
    const parsed = PhaseBudget.parse(JSON.parse(json));
    if (parsed.maxTurns == null && parsed.maxBudgetUsd == null) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function parseRunBudget(json: string | null | undefined): RunBudget {
  if (!json?.trim()) return {};
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (
      raw &&
      typeof raw === "object" &&
      !("plan" in raw) &&
      !("execute" in raw) &&
      !("reflect" in raw) &&
      ("maxTurns" in raw || "maxBudgetUsd" in raw)
    ) {
      return {
        execute: PhaseBudget.parse({
          maxTurns: raw.maxTurns ?? null,
          maxBudgetUsd: raw.maxBudgetUsd ?? null,
        }),
      };
    }
    return RunBudget.parse(raw);
  } catch {
    return {};
  }
}

export function serializePhaseBudget(budget: PhaseBudget | null | undefined): string | null {
  if (!budget) return null;
  if (budget.maxTurns == null && budget.maxBudgetUsd == null) return null;
  return JSON.stringify(budget);
}

export function serializeRunBudget(budget: RunBudget): string | null {
  if (!budget.plan && !budget.execute && !budget.reflect) return null;
  return JSON.stringify(budget);
}

export function mergeRunBudget(existing: RunBudget, patch: Partial<RunBudget>): RunBudget {
  return {
    plan: patch.plan !== undefined ? patch.plan : existing.plan,
    execute: patch.execute !== undefined ? patch.execute : existing.execute,
    reflect: patch.reflect !== undefined ? patch.reflect : existing.reflect,
  };
}

export function resolvePhaseBudget(opts: {
  phase: BudgetPhase;
  runBudget: RunBudget;
  agentPlanBudget?: PhaseBudget | null;
  agentExecuteBudget?: PhaseBudget | null;
  testMode?: boolean;
}): ResolvedPhaseBudget | null {
  if (opts.testMode) {
    const test = TEST_PHASE_BUDGET[opts.phase];
    return {
      maxTurns: test.maxTurns ?? undefined,
      maxBudgetUsd: test.maxBudgetUsd ?? undefined,
    };
  }

  const runPhase = opts.runBudget[opts.phase];
  const agentPhase =
    opts.phase === "plan"
      ? opts.agentPlanBudget
      : opts.phase === "execute"
        ? opts.agentExecuteBudget
        : null;

  const maxTurns = runPhase?.maxTurns ?? agentPhase?.maxTurns ?? null;
  const maxBudgetUsd = runPhase?.maxBudgetUsd ?? agentPhase?.maxBudgetUsd ?? null;

  if (maxTurns == null && maxBudgetUsd == null) return null;

  const resolved: ResolvedPhaseBudget = {};
  if (maxTurns != null) resolved.maxTurns = maxTurns;
  if (maxBudgetUsd != null) resolved.maxBudgetUsd = maxBudgetUsd;
  return resolved;
}

export function budgetCliArgs(budget: ResolvedPhaseBudget | null): string[] {
  if (!budget) return [];
  const args: string[] = [];
  if (budget.maxTurns != null) args.push("--max-turns", String(budget.maxTurns));
  if (budget.maxBudgetUsd != null) args.push("--max-budget-usd", String(budget.maxBudgetUsd));
  return args;
}
