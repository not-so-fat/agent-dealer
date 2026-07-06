import fs from "node:fs";
import path from "node:path";
import type { Run, RunPhase, Runtime } from "@agent-dealer/shared";
import { detectExecutionBlocker } from "@agent-dealer/shared";
import { addArtifact } from "../repository/runs.js";
import { getTemporalOutputDir } from "../paths.js";
import {
  buildStreamTrace,
  extractPlanMarkdown,
  extractResultIsError,
  extractResultText,
  extractSessionId,
  extractUsage,
  parseNdjson,
} from "./stream-json.js";
import { planTracePrefix, executeTracePrefix } from "./run-context.js";

export interface PersistRunOutputInput {
  run: Run;
  phase: RunPhase;
  runtime: Runtime;
  exitCode: number;
  logPath: string;
  rawTranscript?: string;
}

function expectedDocPath(run: Run): string {
  return path.join(getTemporalOutputDir(), `${run.id}.md`);
}

export function persistRunOutput(input: PersistRunOutputInput): {
  planMarkdown?: string;
  resultText?: string;
  sessionId?: string;
  blocked?: boolean;
  blockerSummary?: string;
} {
  const { run, phase, runtime, exitCode, logPath } = input;
  const raw = input.rawTranscript ?? (fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "");
  const events = parseNdjson(raw);

  const sessionId = extractSessionId(events);
  const resultText = extractResultText(events);
  const streamError = extractResultIsError(events);
  const blocker = detectExecutionBlocker(resultText);
  const isError = exitCode !== 0 || streamError || blocker.detected;
  const usage = extractUsage(events, phase, runtime);
  const trace =
    phase === "plan"
      ? [...planTracePrefix(run), ...buildStreamTrace(events)]
      : phase === "execute"
        ? [...executeTracePrefix(run), ...buildStreamTrace(events)]
        : buildStreamTrace(events);

  if (sessionId) {
    addArtifact(run.id, "agent_session", { phase, runtime, sessionId }, "agent");
  }

  addArtifact(run.id, "usage", usage, "agent");
  addArtifact(run.id, "stream_trace", { phase, runtime, entries: trace }, "agent", logPath);
  addArtifact(
    run.id,
    "execution_result",
    {
      phase,
      exitCode,
      resultText,
      isError,
      blocker: blocker.detected ? { summary: blocker.summary } : undefined,
    },
    "agent"
  );

  addArtifact(
    run.id,
    "transcript",
    { phase, exitCode, excerpt: raw.slice(-20000), resultText: resultText?.slice(0, 8000) },
    "agent",
    logPath
  );

  if (phase === "execute") {
    captureDocumentArtifact(run, resultText);
  }

  if (phase === "plan") {
    const planMarkdown = extractPlanMarkdown(events);
    return { planMarkdown, resultText, sessionId, blocked: blocker.detected, blockerSummary: blocker.summary };
  }

  return { resultText, sessionId, blocked: blocker.detected, blockerSummary: blocker.summary };
}

function captureDocumentArtifact(run: Run, resultText?: string): void {
  const docPath = expectedDocPath(run);
  if (fs.existsSync(docPath)) {
    const markdown = fs.readFileSync(docPath, "utf8");
    addArtifact(run.id, "document", { path: docPath, title: run.title, markdown }, "agent");
    return;
  }

  // Fallback: content tasks may return markdown in result without Write tool
  if (
    resultText &&
    (run.taskCategory === "content" || run.taskCategory === "research") &&
    resultText.length > 80
  ) {
    const markdown = resultText.replace(/^```(?:markdown|md)?\s*\n?([\s\S]*?)```\s*$/m, "$1").trim();
    addArtifact(
      run.id,
      "document",
      { path: docPath, title: run.title, markdown },
      "agent"
    );
  }
}

export function documentOutputPath(run: Run): string {
  return expectedDocPath(run);
}

export function documentOutputHint(run: Run): string {
  const p = expectedDocPath(run);
  return [
    `Write the deliverable to this exact path: \`${p}\``,
    `Create parent directories if needed.`,
    `Use markdown format.`,
  ].join("\n");
}
