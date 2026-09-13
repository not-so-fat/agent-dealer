import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Run } from "@agent-dealer/shared";
import { getTemporalLogsDir } from "../paths.js";
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

export function timeoutMsForMode(mode: "plan" | "execute" | "reflect" | "qa"): number {
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

export async function spawnCli(
  runId: string,
  cmd: string,
  args: string[],
  cwd: string,
  opts: { logPath: string; timeoutMs: number; env?: Record<string, string> }
): Promise<{ exitCode: number; transcript: string; timedOut: boolean }> {
  await acquireSpawnSlot();
  try {
    return await new Promise((resolve, reject) => {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      let timedOut = false;
      let settled = false;

      const logStream = fs.createWriteStream(opts.logPath, { flags: "w" });
      // A WriteStream's 'error' event has no default handler — left unguarded, any
      // stream error (a write after end, ENOSPC, a permissions problem) is an uncaught
      // exception that crashes this entire process, taking down every other in-flight
      // issue's coordinator work along with it. Best-effort: the transcript this
      // function resolves with is already buffered in memory regardless of whether the
      // log file write succeeds.
      logStream.on("error", (err) => {
        console.error(`[spawn-cli] log stream error for ${opts.logPath}`, err);
      });

      const child = spawn(cmd, args, {
        cwd,
        // Extra vars (e.g. codex's bearer-token env var for its per-attempt CODEX_HOME
        // MCP config, agent-deck-bind.ts) are added on top of, never in place of, the
        // process env the CLI itself needs to run.
        env: { ...process.env, ...opts.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      registerChild(runId, child, opts.logPath);

      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unregisterChild(runId);
        // Write any stderr BEFORE ending the stream — writing after end() throws
        // ERR_STREAM_WRITE_AFTER_END (this crashed the whole process on any real CLI
        // invocation that produced stderr output; every fixture-based test's fake spawn
        // never wrote stderr, so this path went unexercised until a real session hit it).
        const stderr = stderrChunks.join("");
        if (stderr.trim()) {
          logStream.write(`\n--- stderr ---\n${stderr}`);
        }
        logStream.end();
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

export function logPathFor(run: Run, mode: "plan" | "execute" | "reflect" | "qa"): string {
  const logDir = getTemporalLogsDir();
  return path.join(logDir, `${run.id}-${mode}-${Date.now()}.ndjson`);
}
