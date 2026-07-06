import type { ExecutionResultContent } from "@agent-dealer/shared";
import { resolveExecutionBlocker } from "@agent-dealer/shared";
import MarkdownBody from "../ui/MarkdownBody";

type Props = {
  execResult: ExecutionResultContent;
};

export function ExecutionOutcomeSection({ execResult }: Props) {
  if (!execResult.resultText) return null;

  const blocker = resolveExecutionBlocker(execResult);
  const isBlocked = blocker.detected;

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
      <div
        className={`markdown-body-panel markdown-body-panel--compact ${
          isBlocked ? "border-red-400/30 bg-red-950/20" : ""
        }`}
      >
        <MarkdownBody source={execResult.resultText} />
      </div>
    </section>
  );
}

export function executionHasBlocker(execResult: ExecutionResultContent | null | undefined): boolean {
  if (!execResult) return false;
  return resolveExecutionBlocker(execResult).detected;
}
