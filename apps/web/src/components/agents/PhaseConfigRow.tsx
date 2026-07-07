import type { Runtime } from "@agent-dealer/shared";
import type { BudgetFormValue } from "../../lib/budgetForm";
import ModelSelect from "./ModelSelect";

type Props = {
  phase: "Plan" | "Execution";
  runtime: Runtime;
  model: string;
  onModelChange: (model: string) => void;
  budget: BudgetFormValue;
  onBudgetChange: (budget: BudgetFormValue) => void;
  defaultModelId?: string | null;
  disabled?: boolean;
  showHint?: boolean;
};

export default function PhaseConfigRow({
  phase,
  runtime,
  model,
  onModelChange,
  budget,
  onBudgetChange,
  defaultModelId,
  disabled,
  showHint = true,
}: Props) {
  const setBudget = (patch: Partial<BudgetFormValue>) => onBudgetChange({ ...budget, ...patch });

  return (
    <section className="space-y-2">
      <div className="text-xs uppercase tracking-wide text-[#92E4DD]">{phase}</div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <ModelSelect
          runtime={runtime}
          label="Model"
          value={model}
          onChange={onModelChange}
          defaultModelId={defaultModelId}
          disabled={disabled}
          compact
        />
        <label className="block space-y-1">
          <span className="text-xs text-[#A8C4C0] uppercase">Turns</span>
          <input
            className="field text-sm w-full"
            type="number"
            min={1}
            step={1}
            placeholder="Default"
            disabled={disabled}
            value={budget.maxTurns}
            onChange={(e) => setBudget({ maxTurns: e.target.value })}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-[#A8C4C0] uppercase">Max USD</span>
          <input
            className="field text-sm w-full"
            type="number"
            min={0.01}
            step={0.01}
            placeholder="Default"
            disabled={disabled}
            value={budget.maxBudgetUsd}
            onChange={(e) => setBudget({ maxBudgetUsd: e.target.value })}
          />
        </label>
      </div>
      {showHint && (
        <p className="text-xs text-white/40">Blank turns or USD = runtime default (no cap).</p>
      )}
    </section>
  );
}
