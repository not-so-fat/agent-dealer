import { useState } from "react";
import type { ExecutionResultContent } from "@agent-dealer/shared";
import { resolveExecutionBlocker } from "@agent-dealer/shared";
import MarkdownBody from "../ui/MarkdownBody";

type Props = {
  execResult: ExecutionResultContent;
};

function resultSummaryLine(markdown: string): string {
  const line = markdown
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("```"));
  return line?.replace(/^[-*]\s+/, "").slice(0, 160) ?? "Result ready";
}

export function ExecutionOutcomeSection({ execResult }: Props) {
  const [expanded, setExpanded] = useState(true);

  if (!execResult.resultText) return null;

  const blocker = resolveExecutionBlocker(execResult);
  const isBlocked = blocker.detected;
  const text = execResult.resultText;

  return (
    <section className="space-y-2">
      {isBlocked && (
        <div className="rounded-lg border border-red-400/35 bg-red-500/10 px-3 py-2.5">
          <p className="text-sm font-semibold text-red-300">Blocker — agent could not finish</p>
          {blocker.summary && (
            <p className="text-sm text-red-200/85 mt-1 leading-snug">{blocker.summary}</p>
          )}
          <p className="text-xs text-red-200/60 mt-2">
            Grant the missing permission or adjust settings, then retry with instructions below.
          </p>
        </div>
      )}
      <div className={`heading-section ${isBlocked ? "text-red-300" : ""}`}>
        {isBlocked ? "Blocker details" : "Result"}
      </div>
      {!expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className={`w-full text-left rounded-xl border px-4 py-3 transition-colors ${
            isBlocked
              ? "border-red-400/30 bg-red-950/20 hover:border-red-400/45"
              : "border-white/10 bg-white/[0.03] hover:border-white/20"
          }`}
        >
          <p className="text-sm text-white/75 line-clamp-2">{resultSummaryLine(text)}</p>
          <p className="text-xs text-[#92E4DD] mt-2">Show full result →</p>
        </button>
      )}
      {expanded && (
        <div className="space-y-2">
          <div
            className={`markdown-body-panel markdown-body-panel--flow ${
              isBlocked ? "border-red-400/30 bg-red-950/20" : ""
            }`}
          >
            <MarkdownBody source={text} />
          </div>
          <button type="button" onClick={() => setExpanded(false)} className="btn-ghost text-xs px-2 py-1">
            Show summary
          </button>
        </div>
      )}
    </section>
  );
}

export function executionHasBlocker(execResult: ExecutionResultContent | null | undefined): boolean {
  if (!execResult) return false;
  return resolveExecutionBlocker(execResult).detected;
}
