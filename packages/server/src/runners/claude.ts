import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Run } from "@agent-dealer/shared";
import { buildExecutionPrompt, buildExecutionContinuationPrompt, buildPlanPrompt, buildReflectPrompt, workspaceForRun } from "./prompts.js";
import { humanFeedbackText, lineageParentExecuteSessionId } from "./run-context.js";
import { getTemporalLogsDir } from "../paths.js";
import { cursorInvokeArgs, resolveClaudeBin, resolveCursorBin } from "../cli-env.js";
import { resolveBudgetForPhase, resolveModelForPhase, getRun } from "../repository/runs.js";
import { budgetCliArgs } from "@agent-dealer/shared";
import { buildClaudePhaseArgs } from "./claude-args.js";
import {
  acquireSpawnSlot,
  killRunProcess,
  registerChild,
  releaseSpawnSlot,
  unregisterChild,
} from "./process-registry.js";

export { getActiveLogPath, killRunProcess } from "./process-registry.js";

export interface RunnerResult {
  exitCode: number;
  transcript: string;
  logPath: string;
  timedOut?: boolean;
}

function timeoutMsForMode(mode: "plan" | "execute" | "reflect" | "qa"): number {
  const envKey =
    mode === "plan"
      ? "PLAN_TIMEOUT_MS"
      : mode === "execute"
        ? "EXECUTE_TIMEOUT_MS"
        : mode === "reflect"
          ? "REFLECT_TIMEOUT_MS"
          : "QA_TIMEOUT_MS";
  const defaults: Record<typeof mode, number> = {
    plan: 15 * 60_000,
    execute: 60 * 60_000,
    reflect: 10 * 60_000,
    qa: 5 * 60_000,
  };
  const raw = process.env[envKey];
  if (raw !== undefined && raw !== "") return Number(raw);
  return defaults[mode];
}

async function spawnCli(
  runId: string,
  cmd: string,
  args: string[],
  cwd: string,
  opts: { logPath: string; timeoutMs: number }
): Promise<{ exitCode: number; transcript: string; timedOut: boolean }> {
  await acquireSpawnSlot();
  try {
    return await new Promise((resolve, reject) => {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      let timedOut = false;
      let settled = false;

      const logStream = fs.createWriteStream(opts.logPath, { flags: "w" });

      const child = spawn(cmd, args, {
        cwd,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      registerChild(runId, child, opts.logPath);

      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unregisterChild(runId);
        logStream.end();
        const stderr = stderrChunks.join("");
        if (stderr.trim()) {
          logStream.write(`\n--- stderr ---\n${stderr}`);
        }
        resolve({
          exitCode,
          transcript: stdoutChunks.join(""),
          timedOut,
        });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killRunProcess(runId);
        setTimeout(() => finish(124), 500);
      }, opts.timeoutMs);

      child.stdout?.on("data", (buf: Buffer) => {
        const chunk = buf.toString();
        stdoutChunks.push(chunk);
        logStream.write(buf);
      });
      child.stderr?.on("data", (buf: Buffer) => {
        stderrChunks.push(buf.toString());
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unregisterChild(runId);
        logStream.end();
        reject(err);
      });
      child.on("close", (code) => finish(code ?? 1));
    });
  } finally {
    releaseSpawnSlot();
  }
}

function logPathFor(run: Run, mode: "plan" | "execute" | "reflect" | "qa"): string {
  const logDir = getTemporalLogsDir();
  return path.join(logDir, `${run.id}-${mode}-${Date.now()}.ndjson`);
}

export async function runClaude(
  run: Run,
  mode: "execute" | "plan" | "reflect" | "qa" = "execute",
  model?: string,
  opts?: { promptOverride?: string; resumeSessionId?: string }
): Promise<RunnerResult> {
  const mcpConfig =
    process.env.CLAUDE_MCP_CONFIG ?? path.join(process.env.HOME ?? "", ".claude.json");
  if (!fs.existsSync(mcpConfig)) {
    throw new Error(`MCP config not found: ${mcpConfig}. Set CLAUDE_MCP_CONFIG.`);
  }

  if (mode === "qa" && !opts?.promptOverride) {
    throw new Error("qa mode requires a promptOverride");
  }

  const phaseBudget = mode === "qa" ? null : resolveBudgetForPhase(run, mode);

  const resumeSessionId =
    opts?.resumeSessionId ??
    (mode === "execute" && humanFeedbackText(run) ? lineageParentExecuteSessionId(run) : null);

  const prompt =
    opts?.promptOverride ??
    (mode === "plan"
      ? buildPlanPrompt(run)
      : mode === "reflect"
        ? buildReflectPrompt(run, { trigger: "retry" })
        : resumeSessionId
          ? buildExecutionContinuationPrompt(run)
          : buildExecutionPrompt(run));
  const logPath = logPathFor(run, mode);

  const args = [
    ...(model ? ["--model", model] : []),
    ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
    "-p",
    prompt,
    "--mcp-config",
    mcpConfig,
    ...budgetCliArgs(phaseBudget),
    ...buildClaudePhaseArgs(run, mode),
  ];

  const { exitCode, transcript, timedOut } = await spawnCli(
    run.id,
    resolveClaudeBin(),
    args,
    workspaceForRun(run),
    { logPath, timeoutMs: timeoutMsForMode(mode) }
  );
  return { exitCode, transcript, logPath, timedOut };
}

export async function runCursor(
  run: Run,
  mode: "execute" | "plan" | "qa" = "execute",
  model?: string,
  opts?: { promptOverride?: string; resumeSessionId?: string }
): Promise<RunnerResult> {
  if (mode === "qa" && !opts?.promptOverride) {
    throw new Error("qa mode requires a promptOverride");
  }
  const prompt =
    opts?.promptOverride ?? (mode === "plan" ? buildPlanPrompt(run) : buildExecutionPrompt(run));
  const logPath = logPathFor(run, mode);

  const args = cursorInvokeArgs([
    "-p",
    "--trust",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    ...(mode === "qa" ? ["--mode", "ask"] : []),
    ...(opts?.resumeSessionId ? ["--resume", opts.resumeSessionId] : []),
    ...(model ? ["--model", model] : []),
    prompt,
  ]);

  const { exitCode, transcript, timedOut } = await spawnCli(
    run.id,
    resolveCursorBin(),
    args,
    workspaceForRun(run),
    { logPath, timeoutMs: timeoutMsForMode(mode) }
  );
  return { exitCode, transcript, logPath, timedOut };
}

export async function runAgent(
  run: Run,
  mode: "execute" | "plan" = "execute",
  revise?: { resumeSessionId?: string; prompt: string }
): Promise<RunnerResult> {
  const fresh = getRun(run.id) ?? run;
  const model = resolveModelForPhase(fresh, mode);
  if (fresh.runtime === "cursor_local") return runCursor(fresh, mode, model);
  return runClaude(
    fresh,
    mode,
    model,
    revise ? { promptOverride: revise.prompt, resumeSessionId: revise.resumeSessionId } : undefined
  );
}

/** @deprecated use stream-json extractPlanMarkdown via persistRunOutput */
export function extractPlanFromTranscript(transcript: string): string {
  for (const line of transcript.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as {
        type?: string;
        result?: string;
        message?: { content?: Array<{ text?: string }> };
      };
      if (obj.type === "result" && obj.result) return obj.result;
      if (obj.message?.content) {
        const text = obj.message.content.map((c) => c.text ?? "").join("");
        if (text.length > 50) return text;
      }
    } catch {
      // skip
    }
  }
  return transcript.slice(-8000);
}
