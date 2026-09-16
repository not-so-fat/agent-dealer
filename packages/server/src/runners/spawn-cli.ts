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

/**
 * Grace period between the SIGTERM an abort sends and the SIGKILL that follows it. The
 * agent CLIs spawn their own children (login shells, test runners), and they reap those
 * themselves on SIGTERM the way they do on Ctrl-C — so terminating politely first is what
 * actually cleans up the whole tree. SIGKILL is only the backstop for a CLI that ignores
 * the first signal.
 */
function abortKillGraceMs(): number {
  return Number(process.env.SPAWN_ABORT_KILL_GRACE_MS ?? 5_000);
}

export async function spawnCli(
  runId: string,
  cmd: string,
  args: string[],
  cwd: string,
  opts: {
    logPath: string;
    timeoutMs: number;
    env?: Record<string, string>;
    /**
     * Aborting terminates the spawned CLI (NOT-126). Without this, an attempt that loses
     * its lease leaves its agent process running: still editing the worktree, still
     * spending tokens, under a session the DB has already marked failed — and the
     * successor attempt then reuses that same worktree, so two live agents share one tree.
     */
    signal?: AbortSignal;
  }
): Promise<{ exitCode: number; transcript: string; timedOut: boolean }> {
  await acquireSpawnSlot();
  try {
    return await new Promise((resolve, reject) => {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      let timedOut = false;
      let settled = false;
      let killEscalation: ReturnType<typeof setTimeout> | undefined;

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

      const onAbort = () => {
        if (settled) return;
        try {
          child.kill("SIGTERM");
        } catch {
          // Already exited between the abort firing and this kill — nothing to signal.
        }
        killEscalation = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Same race as above; the 'close' handler still settles the promise.
          }
        }, abortKillGraceMs());
        killEscalation.unref?.();
      };
      // Not cleared on settle alone — `cleanupAbort` also drops the listener, so a
      // long-lived signal (one AbortController per work item, reused across the
      // handler's later stages) never retains this closure after the child is gone.
      const cleanupAbort = () => {
        if (killEscalation) clearTimeout(killEscalation);
        opts.signal?.removeEventListener("abort", onAbort);
      };
      if (opts.signal) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanupAbort();
        unregisterChild(runId);
        // Write any stderr BEFORE ending the stream — writing after end() throws
        // ERR_STREAM_WRITE_AFTER_END (this crashed the whole process on any real CLI
        // invocation that produced stderr output; every fixture-based test's fake spawn
        // never wrote stderr, so this path went unexercised until a real session hit it).
        const stderr = stderrChunks.join("");
        // write()/end() only queue the I/O — resolving immediately (PR #27 review) races
        // the actual flush, so a caller reading opts.logPath right after this promise
        // settles can see a file missing the stderr trailer (or, on a slow disk, even
        // the tail of stdout). Wait for the stream to actually finish (or, if the
        // underlying write itself errors, the 'error' handler above already logged it —
        // finalize anyway rather than hang forever on a transcript that's already fully
        // buffered in memory regardless of the file write's outcome).
        let finalized = false;
        let finalizeTimer: ReturnType<typeof setTimeout> | undefined;
        const finalize = () => {
          if (finalized) return;
          finalized = true;
          if (finalizeTimer) clearTimeout(finalizeTimer);
          resolve({
            exitCode,
            transcript: stdoutChunks.join(""),
            timedOut,
          });
        };
        if (logStream.destroyed || logStream.errored) {
          // The stream already failed (e.g. ENOENT on open, or a write error during
          // stdout streaming — before this function ever attached the listeners below)
          // — end() on an already-destroyed stream emits neither 'finish' nor a fresh
          // 'error', so waiting for either would hang this promise forever and leak the
          // spawn slot (PR #27 review, round 2). The transcript is already fully
          // buffered in memory regardless of the file write's outcome.
          finalize();
        } else {
          logStream.once("finish", finalize);
          logStream.once("error", finalize);
          // Belt-and-suspenders: 'finish'/'error' are expected to fire quickly once
          // end() is called, but a stream wedged on some other, unanticipated failure
          // mode must still never pin this work item's spawn slot indefinitely.
          finalizeTimer = setTimeout(finalize, 2000);
          finalizeTimer.unref?.();
          if (stderr.trim()) {
            logStream.end(`\n--- stderr ---\n${stderr}`);
          } else {
            logStream.end();
          }
        }
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
        cleanupAbort();
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
