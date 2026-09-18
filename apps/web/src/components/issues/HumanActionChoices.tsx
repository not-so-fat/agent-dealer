import { isDestructiveChoice, type ResponseOption } from "../../lib/humanActions";

type Props = {
  options: ResponseOption[];
  disabled?: boolean;
  onChoose: (choice: string) => void;
};

/** Buttons for a human action's server-declared response options — never hardcodes choices. */
export default function HumanActionChoices({ options, disabled, onChoose }: Props) {
  if (options.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => (
        <button
          key={opt.choice}
          type="button"
          className={`${isDestructiveChoice(opt.choice) ? "btn-ghost-danger" : "btn-gold"} px-3 py-1 text-xs disabled:opacity-50`}
          disabled={disabled}
          onClick={() => onChoose(opt.choice)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
