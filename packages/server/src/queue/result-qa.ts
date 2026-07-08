import { randomUUID } from "node:crypto";
import type { Run, ResultQaContent } from "@agent-dealer/shared";
import { addArtifact, getRun } from "../repository/runs.js";
import { hasPendingQaExchange, latestExecuteSessionId } from "../repository/result-qa.js";
import { runQa, type QaRunResult } from "../runners/qa.js";

export type QaRunner = (
  run: Run,
  question: string,
  resumeSessionId: string | null
) => Promise<QaRunResult>;

export type AskQuestionResult =
  | { ok: true; exchange: ResultQaContent }
  | { ok: false; code: 400 | 404 | 409; error: string };

const ASKABLE_STATUSES = new Set(["review", "done"]);

/** Ask the run's agent about its finished result. Read-only; never changes run status. */
export function askResultQuestion(
  runId: string,
  question: string,
  opts?: { runner?: QaRunner }
): AskQuestionResult {
  // An empty question would persist a result_qa artifact that ResultQaContent then
  // refuses to parse — invisible in the thread, and hasPendingQaExchange would miss
  // it, defeating the one-pending-question lock. Reject before spending anything.
  const trimmed = question.trim();
  if (!trimmed) return { ok: false, code: 400, error: "Question cannot be empty" };

  const run = getRun(runId);
  if (!run) return { ok: false, code: 404, error: "Not found" };
  if (!ASKABLE_STATUSES.has(run.status)) {
    return { ok: false, code: 409, error: `Can only ask about a finished result — run is ${run.status}` };
  }
  if ((run.runtime ?? "claude_code") !== "claude_code") {
    return { ok: false, code: 409, error: "Q&A requires the claude_code runtime" };
  }
  // The pending check and the insert below must stay in one synchronous block: every
  // call here is sync (better-sqlite3), so no other request can interleave between them.
  // Do not introduce an `await` before addArtifact — that would open a double-ask window.
  if (hasPendingQaExchange(runId)) {
    return { ok: false, code: 409, error: "A question is already being answered" };
  }

  const resumeSessionId = latestExecuteSessionId(runId);
  const exchange: ResultQaContent = {
    exchangeId: randomUUID(),
    question: trimmed,
    status: "pending",
    sessionResumed: Boolean(resumeSessionId),
    askedAt: new Date().toISOString(),
  };
  addArtifact(runId, "result_qa", exchange, "human");

  void answerExchange(run, exchange, resumeSessionId, opts?.runner ?? runQa);
  return { ok: true, exchange };
}

async function answerExchange(
  run: Run,
  exchange: ResultQaContent,
  resumeSessionId: string | null,
  runner: QaRunner
): Promise<void> {
  let result: QaRunResult;
  try {
    result = await runner(run, exchange.question, resumeSessionId);
  } catch (e) {
    appendExchange(run.id, { ...exchange, status: "failed", error: String(e) });
    return;
  }

  addArtifact(run.id, "usage", result.usage, "agent");

  if (!result.ok) {
    appendExchange(run.id, { ...exchange, status: "failed", error: result.error ?? "Q&A failed" });
    return;
  }
  appendExchange(run.id, {
    ...exchange,
    status: "answered",
    answer: result.answer,
    answeredAt: new Date().toISOString(),
  });
}

function appendExchange(runId: string, exchange: ResultQaContent): void {
  addArtifact(runId, "result_qa", exchange, "agent");
}
