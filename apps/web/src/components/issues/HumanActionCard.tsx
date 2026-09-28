import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { HumanAction } from "@agent-dealer/shared";
import { summarizeHumanAction } from "@agent-dealer/shared";
import HumanActionChoices from "./HumanActionChoices";
import { actionLabel } from "../../lib/humanActions";

type Props = {
  action: HumanAction;
  /** When set, the summary title links out (Issues home issue-scoped rows). */
  linkTo?: string | null;
  /** When set, the server-declared choices render as buttons (Issue Detail,
   * run-scoped home items). When omitted, the expected choices are named as
   * text so both surfaces still agree on labels without resolving off-page. */
  onChoose?: ((choice: string) => void) | null;
  disabled?: boolean;
  /** Extra controls under the choices (e.g. the scope-decision note field). */
  children?: ReactNode;
  /** Hide the "To decide:" hint line (callers rendering their own controls). */
  hideChoicesHint?: boolean;
};

/**
 * NOT-288: the one compact rendering of a human action, shared by the Issues
 * home NeedsAttentionPanel and Issue Detail. Default view is a short question
 * plus one-sentence context with the server-declared choices — never a git
 * command block. The full stored question/reason, exact recovery commands,
 * worktree paths, recovery facts, and structured evidence live under Details,
 * verbatim and untruncated, so the timeline/evidence stay auditable and
 * pre-change open actions render sensibly.
 */
export default function HumanActionCard({ action, linkTo, onChoose, disabled, children, hideChoicesHint }: Props) {
  const summary = summarizeHumanAction(action);
  const title = linkTo ? (
    <Link to={linkTo} className="text-sm text-white/85 hover:text-white hover:underline">
      {summary.title}
    </Link>
  ) : (
    <span className="text-sm text-white/85">{summary.title}</span>
  );

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs uppercase tracking-wide text-red-300/80">{actionLabel(action.actionType)}</span>
        <span className="text-xs text-white/35 shrink-0">
          {new Date(action.requestedAt).toLocaleString()}
        </span>
      </div>
      <div>{title}</div>
      {summary.context && <p className="text-xs text-white/55">{summary.context}</p>}
      {onChoose ? (
        summary.displayOptions.length > 0 ? (
          <HumanActionChoices options={summary.displayOptions} disabled={disabled} onChoose={onChoose} />
        ) : (
          <p className="text-xs text-amber-200/80">
            This item declares no response options — resolve it from the CLI
            (<code>agent-dealer action</code>).
          </p>
        )
      ) : (
        !hideChoicesHint &&
        summary.displayOptions.length > 0 && (
          <p className="text-xs text-white/50">
            To decide: {summary.displayOptions.map((o) => o.label).join(" · ")}
          </p>
        )
      )}
      {children}
      <details>
        <summary className="text-xs text-white/45 cursor-pointer hover:text-white/70">Details</summary>
        <div className="mt-1.5 space-y-1.5 rounded border border-white/10 bg-black/20 px-3 py-2">
          <p className="text-xs text-white/60 whitespace-pre-wrap">{summary.details.question}</p>
          {summary.details.question !== summary.details.reason && (
            <p className="text-xs text-white/60 whitespace-pre-wrap">{summary.details.reason}</p>
          )}
          {summary.details.factLines.map((line) => (
            <p key={line} className="text-xs text-white/60">
              {line}
            </p>
          ))}
          {summary.details.paths.length > 0 && (
            <div className="text-xs text-white/60">
              <p className="text-white/40">Saved paths:</p>
              {summary.details.paths.map((p) => (
                <p key={p} className="font-mono break-all">
                  {p}
                </p>
              ))}
            </div>
          )}
          {summary.details.commands.length > 0 && (
            <div className="text-xs text-white/60">
              <p className="text-white/40">Recovery commands:</p>
              <pre className="font-mono whitespace-pre-wrap break-all">{summary.details.commands.join("\n")}</pre>
            </div>
          )}
          {summary.details.evidencePretty && (
            <div className="text-xs text-white/60">
              <p className="text-white/40">Evidence:</p>
              <pre className="font-mono whitespace-pre-wrap break-all">{summary.details.evidencePretty}</pre>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
