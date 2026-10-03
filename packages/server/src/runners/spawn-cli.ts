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

/**
 * NOT-307: what `spawnCli` reports about the child besides its exit.
 * `idleTimedOut` is true only when the idle watchdog (not the wall clock) killed the
 * child; `timedOut` is true for either kill so downstream timeout handling (salvage,
 * infra-retry accounting) treats both identically. `firstOutputMs` is spawn → first
 * stdout bytes (null when the child never wrote any); `lastActivityAt` is the last
 * observed progress (stdout bytes, or `progressSource` when the caller supplies one).
 */
export interface SpawnCliResult {
  exitCode: number;
  transcript: string;
  timedOut: boolean;
  idleTimedOut: boolean;
  /**
   * NOT-342: true only when `terminalGrace` matched a stdout line and the child was
   * killed after that grace because it had not closed. Never implies `timedOut` or
   * `idleTimedOut` — those stay false so the terminal event's own cause is used.
   */
  lingeredAfterTerminal: boolean;
  firstOutputMs: number | null;
  lastActivityAt: string | null;
  /** Silence observed at an idle kill (now minus last activity); null otherwise. */
  idleForMs: number | null;
}

/**
 * NOT-225: a NUL byte anywhere in argv makes `child_process.spawn` throw
 * `ERR_INVALID_ARG_VALUE` synchronously, before any process exists — so a reviewer
 * prompt embedding a PR diff with a raw NUL could never start, and the throw was
 * swallowed upstream as a generic session failure. Replace each U+0000 with the
 * visible six-character text `\u0000` so the session still runs and the reviewer can
 * see the diff contains it. Pure and total: NUL-free args are returned untouched
 * (same string values, no re-encoding — non-ASCII passes through byte-identical).
 * Env values are out of scope.
 */
export function sanitizeArgv(args: string[]): string[] {
  return args.map((arg) => (arg.includes("\0") ? arg.split("\0").join("\\u0000") : arg));
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
     * NOT-278: when true, the child receives exactly `opts.env` — `process.env` is not
     * merged back in. The Muse exec lane uses this with the approved `attempt.env` so ambient
     * `META_API_KEY`, `MUSE_*`, `CODEX_HOME`, and unrelated variables can never reach the
     * child. Defaults to false (merge), preserving every existing caller.
     */
    exactEnv?: boolean;
    /**
     * NOT-278: payload written once to the child's stdin, then closed. Carries the Muse
     * API key (`--api-key-stdin`) without touching argv, environment, settings, or logs.
     * Never logged or echoed; defaults to no stdin payload (`stdio: ["ignore", ...]`).
     */
    stdin?: string;
    /**
     * Aborting terminates the spawned CLI (NOT-126). Without this, an attempt that loses
     * its lease leaves its agent process running: still editing the worktree, still
     * spending tokens, under a session the DB has already marked failed — and the
     * successor attempt then reuses that same worktree, so two live agents share one tree.
     */
    signal?: AbortSignal;
    /**
     * Called once with the spawned CLI's pid, as soon as it exists (NOT-124). The
     * coordinator persists it so recovery can verify the worker is really gone before
     * presuming it dead — a host that slept froze the heartbeat but not the process.
     * Never called when the spawn itself fails (no child, so nothing to prove alive).
     */
    onSpawn?: (pid: number) => void;
    /**
     * NOT-307: silent-child watchdog, Muse lane only for now (Codex/Claude/Cursor pass
     * nothing and are unaffected). When set to a positive finite number of milliseconds,
     * the child is killed exactly like a wall-clock timeout (SIGTERM via killRunProcess,
     * `finish(124)` 500ms later) if neither stdout bytes nor `progressSource` report
     * progress for that long. Undefined, non-numeric, or non-positive disables it.
     */
    idleTimeoutMs?: number;
    /**
     * NOT-307: extra progress source sampled by the idle watchdog — epoch milliseconds
     * of the last externally observed activity (e.g. the Muse session-log mtime), or
     * null when unknown. Throwing or returning a non-number is treated as unknown and
     * never breaks the spawn. Ignored unless `idleTimeoutMs` enables the watchdog.
     */
    progressSource?: () => number | null;
    /**
     * NOT-307: per-line stdout arrival hook for post-hoc timing. The child's stream
     * envelopes carry no usable event time (`recorded_at` is batch-stamped — every
     * envelope of a real session shares one ~40ms window), so per-event `ts` in the
     * normalized log is stamped Dealer-side: each complete stdout line is reported
     * with its arrival epoch milliseconds. Unset (every existing caller) means no
     * line splitting happens at all. A throwing hook never breaks the spawn; a
     * trailing partial line is flushed on child close.
     */
    onStdoutLine?: (line: string, atMs: number) => void;
    /**
     * NOT-342: opt-in kill after a terminal stdout line. When `isTerminalLine`
     * matches a complete stdout line and the child has not closed within `graceMs`,
     * the child is SIGTERM'd (then SIGKILL after the abort-kill grace) and the
     * spawn settles with `lingeredAfterTerminal: true`. Does not set `timedOut` or
     * `idleTimedOut`. Undefined, non-positive `graceMs`, or a throwing/false
     * predicate leaves existing callers unchanged. Muse is the only production
     * lane that opts in.
     */
    terminalGrace?: {
      isTerminalLine: (line: string) => boolean;
      graceMs: number;
    };
  }
): Promise<SpawnCliResult> {
  await acquireSpawnSlot();
  try {
    return await new Promise<SpawnCliResult>((resolve, reject) => {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      let timedOut = false;
      let settled = false;
      let lingeredAfterTerminal = false;
      let killEscalation: ReturnType<typeof setTimeout> | undefined;

      // NOT-307: idle watchdog state. lastActivityMs starts at spawn so a child that
      // never emits anything is killed after exactly idleTimeoutMs. stdout bytes always
      // count; progressSource (when supplied) can only move the mark forward, never back.
      const spawnStartMs = Date.now();
      let firstOutputMs: number | null = null;
      let lastActivityMs = spawnStartMs;
      let idleTimedOut = false;
      let aborted = false;
      const idleMs = opts.idleTimeoutMs;
      const idleEnabled =
        typeof idleMs === "number" && Number.isFinite(idleMs) && idleMs > 0;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let progressTimer: ReturnType<typeof setInterval> | undefined;
      let terminalGraceTimer: ReturnType<typeof setTimeout> | undefined;
      let terminalGraceArmed = false;
      const terminalGraceMs = opts.terminalGrace?.graceMs;
      const terminalGraceEnabled =
        typeof terminalGraceMs === "number" &&
        Number.isFinite(terminalGraceMs) &&
        terminalGraceMs > 0 &&
        typeof opts.terminalGrace?.isTerminalLine === "function";
      const clearIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (progressTimer) clearInterval(progressTimer);
        idleTimer = undefined;
        progressTimer = undefined;
      };
      const clearTerminalGrace = () => {
        if (terminalGraceTimer) clearTimeout(terminalGraceTimer);
        terminalGraceTimer = undefined;
      };
      const rescheduleIdle = () => {
        if (!idleEnabled || settled || aborted || lingeredAfterTerminal) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(fireIdle, idleMs as number);
        idleTimer.unref?.();
      };
      const noteActivity = (atMs?: number) => {
        const now = typeof atMs === "number" && Number.isFinite(atMs) ? atMs : Date.now();
        // A stale report (an old mtime re-read, a same-millisecond second chunk) leaves
        // the deadline standing: only genuinely newer activity postpones the kill, so a
        // source stuck on an old value can never hold the watchdog off indefinitely.
        if (firstOutputMs === null) firstOutputMs = Math.max(0, now - spawnStartMs);
        if (now <= lastActivityMs) return;
        lastActivityMs = now;
        rescheduleIdle();
      };
      // Mirror the wall-clock timeout path exactly (same SIGTERM, same finish(124) 500ms
      // later) so salvage and infra-retry accounting treat an idle kill as a timeout.
      // Never fires after an abort: a lost lease is not idleness.
      function fireIdle() {
        if (settled || aborted || lingeredAfterTerminal) return;
        idleTimedOut = true;
        timedOut = true;
        killRunProcess(runId);
        setTimeout(() => finish(124), 500);
      }
      // Same polite SIGTERM → SIGKILL backstop the abort path uses: the CLI should
      // reap its own children on SIGTERM. Does not settle the promise — `close` does.
      const requestKill = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          // Already exited between the decision and this kill — nothing to signal.
        }
        if (killEscalation) clearTimeout(killEscalation);
        killEscalation = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Same race as above; the 'close' handler still settles the promise.
          }
        }, abortKillGraceMs());
        killEscalation.unref?.();
      };
      function fireTerminalGrace() {
        if (settled || aborted) return;
        lingeredAfterTerminal = true;
        clearIdle();
        requestKill();
      }
      const maybeArmTerminalGrace = (line: string) => {
        if (!terminalGraceEnabled || settled || aborted || terminalGraceArmed) return;
        let match = false;
        try {
          match = opts.terminalGrace!.isTerminalLine(line) === true;
        } catch (err) {
          console.error(`[spawn-cli] terminalGrace.isTerminalLine for ${runId}`, err);
          return;
        }
        if (!match) return;
        terminalGraceArmed = true;
        terminalGraceTimer = setTimeout(fireTerminalGrace, terminalGraceMs as number);
        terminalGraceTimer.unref?.();
      };

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

      // NOT-225: sanitize before spawn — a raw NUL in any arg throws
      // ERR_INVALID_ARG_VALUE synchronously (no process, no pid, no log).
      const child = spawn(cmd, sanitizeArgv(args), {
        cwd,
        // Extra vars (e.g. codex's bearer-token env var for its per-attempt CODEX_HOME
        // MCP config, agent-deck-bind.ts) are added on top of, never in place of, the
        // process env the CLI itself needs to run — unless the caller asked for the exact
        // environment (NOT-278: the Muse exec lane's approved attempt.env, stdin key).
        env: opts.exactEnv ? { ...opts.env } : { ...process.env, ...opts.env },
        stdio: opts.stdin === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      });
      // NOT-278: the stdin payload (Muse API key) is written once and closed right after
      // spawn. It never reaches the log stream, the transcript, or any error below.
      if (opts.stdin !== undefined) {
        const payload = opts.stdin;
        const stdin = child.stdin;
        if (stdin) {
          stdin.on("error", () => {
            // The child exited before reading (e.g. instant spawn error) — the 'error'/'close'
            // handlers below still settle the promise; a broken pipe must not throw here.
          });
          stdin.end(payload);
        }
      }
      registerChild(runId, child, opts.logPath);
      // Best-effort bookkeeping: a throwing callback must never take down the spawn.
      if (child.pid !== undefined) {
        try {
          opts.onSpawn?.(child.pid);
        } catch (err) {
          console.error(`[spawn-cli] onSpawn for ${runId}`, err);
        }
      }

      const onAbort = () => {
        if (settled) return;
        aborted = true;
        clearIdle();
        clearTerminalGrace();
        requestKill();
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

      // NOT-307: line splitter for onStdoutLine only — untouched when no hook is set.
      // Declared before finish() so no path can observe the bindings uninitialized.
      let lineTail = "";
      const emitLine = (line: string) => {
        const hook = opts.onStdoutLine;
        if (!hook) return;
        try {
          hook(line, Date.now());
        } catch (err) {
          console.error(`[spawn-cli] onStdoutLine for ${runId}`, err);
        }
      };
      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        // A final line without a trailing newline still arrived — report it at close time.
        if (opts.onStdoutLine && lineTail !== "") {
          const tail = lineTail;
          lineTail = "";
          emitLine(tail);
        }
        clearTimeout(timer);
        clearIdle();
        clearTerminalGrace();
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
            idleTimedOut,
            lingeredAfterTerminal,
            firstOutputMs,
            lastActivityAt: new Date(lastActivityMs).toISOString(),
            idleForMs: idleTimedOut ? Math.max(0, Date.now() - lastActivityMs) : null,
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
        if (settled || lingeredAfterTerminal) return;
        timedOut = true;
        killRunProcess(runId);
        setTimeout(() => finish(124), 500);
      }, opts.timeoutMs);

      // NOT-307: arm the idle watchdog once the child exists. The first deadline is one
      // full idle window after spawn (lastActivityMs starts at spawn), so a child that
      // never emits anything is killed after exactly idleTimeoutMs.
      if (idleEnabled) {
        rescheduleIdle();
        if (opts.progressSource) {
          // Sample at most every 30s and at least every handful of ms: frequent enough
          // that the kill lands near the bound, sparse enough to never matter for I/O.
          const pollMs = Math.min(Math.max(Math.floor((idleMs as number) / 10), 50), 30_000);
          progressTimer = setInterval(() => {
            if (settled || aborted || lingeredAfterTerminal) return;
            let at: number | null = null;
            try {
              at = opts.progressSource?.() ?? null;
            } catch {
              at = null;
            }
            if (typeof at === "number" && Number.isFinite(at) && at >= spawnStartMs) {
              noteActivity(at);
            }
          }, pollMs);
          progressTimer.unref?.();
        }
      }

      child.stdout?.on("data", (buf: Buffer) => {
        const chunk = buf.toString();
        stdoutChunks.push(chunk);
        logStream.write(buf);
        // NOT-307: any stdout bytes are progress. (stderr deliberately does not count:
        // the contract defines progress as stdout bytes or the external source.)
        noteActivity();
        if (opts.onStdoutLine || terminalGraceEnabled) {
          lineTail += chunk;
          let idx: number;
          while ((idx = lineTail.indexOf("\n")) >= 0) {
            const line = lineTail.slice(0, idx);
            lineTail = lineTail.slice(idx + 1);
            emitLine(line);
            maybeArmTerminalGrace(line);
          }
        }
      });
      child.stderr?.on("data", (buf: Buffer) => {
        stderrChunks.push(buf.toString());
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearIdle();
        clearTerminalGrace();
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
