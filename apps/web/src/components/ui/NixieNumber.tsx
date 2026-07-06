const DIGITS = 3;

function padCount(value: number): string {
  const n = Number.isFinite(value) ? value : 0;
  return String(Math.min(999, Math.max(0, n))).padStart(DIGITS, "0");
}

type NixieDisplayProps = {
  value: number;
  /** Screen-reader label when not wrapped by a labelled control */
  label?: string;
};

/** Three-digit nixie tube row (e.g. 000). */
export function NixieDisplay({ value, label }: NixieDisplayProps) {
  const digits = padCount(value).split("");

  return (
    <div className="nixie-housing" aria-hidden={!label} aria-label={label}>
      {digits.map((digit, index) => (
        <span key={`${index}-${digit}`} className="nixie-tube">
          <span className="nixie-tube-ghost">8</span>
          <span className="nixie-tube-digit">{digit}</span>
        </span>
      ))}
    </div>
  );
}
