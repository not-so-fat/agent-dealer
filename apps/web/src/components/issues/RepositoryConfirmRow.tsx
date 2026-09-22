import type { LinearRepoResolution } from "@agent-dealer/shared";

type Props = {
  /** Canonical `github.com/<owner>/<repo>` parsed from the current input, if valid. */
  canonical: string | null;
  /** The exact identity the operator confirmed, or null. */
  confirmedRepo: string | null;
  /** Linear hint in From-Linear mode; null for manual creation. */
  hint: LinearRepoResolution | null;
  /** Selected Linear identifier (e.g. NOT-242) for unresolved copy. */
  linearIdentifier: string | null;
  onConfirm: () => void;
  /** Opens the existing recent-repository / custom-entry control. */
  onChangeRepo: () => void;
};

/**
 * NOT-242: high-emphasis Repository confirmation row, visually separated from
 * the title/body fields. Names the exact canonical identity and its source
 * label, and blocks submit until the operator confirms it.
 */
export default function RepositoryConfirmRow({
  canonical,
  confirmedRepo,
  hint,
  linearIdentifier,
  onConfirm,
  onChangeRepo,
}: Props) {
  const confirmed = canonical != null && confirmedRepo === canonical;
  const conflictLabels = hint?.status === "conflict" ? (hint.labels ?? []) : [];
  const invalidLabel = hint?.status === "invalid" ? (hint.labels?.[0] ?? null) : null;

  return (
    <section
      aria-label="Repository confirmation"
      className="rounded border border-amber-200/30 bg-amber-100/5 px-3 py-2 space-y-1.5"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-ui-display text-sm font-semibold text-amber-100">Repository</h3>
        <button
          type="button"
          className="font-ui-display text-xs text-white/50 hover:text-white underline underline-offset-2"
          onClick={onChangeRepo}
        >
          Change
        </button>
      </div>

      {canonical ? (
        <p className="font-mono text-sm font-semibold text-white/90" data-testid="repo-canonical">
          {canonical}
        </p>
      ) : (
        <p className="text-sm text-white/50" data-testid="repo-canonical">
          No valid repository entered yet
        </p>
      )}

      {hint?.status === "resolved" && hint.sourceLabel ? (
        <p className="text-xs text-white/55">
          From Linear label <code className="font-mono text-white/80">{hint.sourceLabel}</code>
        </p>
      ) : hint?.status === "unresolved" ? (
        <p className="text-xs text-amber-200/90">
          {linearIdentifier ?? "This issue"} has no <code className="font-mono">repo:</code> label.
          Add <code className="font-mono">repo:github.com/&lt;owner&gt;/&lt;repo&gt;</code> in
          Linear, or choose the repository manually below.
        </p>
      ) : hint?.status === "conflict" ? (
        <div className="text-xs text-red-300 space-y-1">
          <p>
            Conflicting <code className="font-mono">repo:</code> labels — fix them in Linear, or
            choose manually below. Dealer never picks one for you:
          </p>
          <ul className="list-disc pl-5 font-mono">
            {conflictLabels.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      ) : hint?.status === "invalid" ? (
        <p className="text-xs text-red-300">
          Invalid repository label{" "}
          <code className="font-mono">{invalidLabel}</code>
          {hint.error ? ` — ${hint.error}` : ""}. Fix the label in Linear, or choose manually below.
        </p>
      ) : (
        <p className="text-xs text-white/55">Manual entry — no Linear source.</p>
      )}

      {confirmed ? (
        <p className="text-xs font-medium text-emerald-300" data-testid="repo-confirmed">
          ✓ Repository confirmed — {confirmedRepo}
        </p>
      ) : (
        <button
          type="button"
          className="font-ui-display px-3 py-1.5 rounded border border-amber-200/40 text-amber-100 text-xs disabled:opacity-40"
          disabled={!canonical}
          onClick={onConfirm}
          data-testid="repo-confirm"
        >
          Confirm this repository
        </button>
      )}
    </section>
  );
}
