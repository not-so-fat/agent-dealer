// packages/server/src/coordinator/muse-spawn.ts
//
// NOT-181: the native Muse Code developer spawn. Wires the already-tested pieces — binary
// resolution (cli-env.ts), argv (runners/muse-code-args.ts), JSONL/session-log parsing
// (runners/muse-code-jsonl.ts) — into the existing developer-effect contract without changing
// either side:
//
//   1. a per-attempt config + data dir under the worktree (`.dealer-muse/<attempt>/`, kept out of
//      git via info/exclude): `settings.json` with no MCP servers, a symlinked `auth.json`;
//   2. `spawnCli` with `XDG_CONFIG_HOME`/`XDG_DATA_HOME` pointed at it;
//   3. the on-disk session log (usage + confirmed model exist only there) read while the dir still
//      exists, then the dir is removed on success *and* failure;
//   4. the raw stdout archived next to the log, and the log itself rewritten as Claude/Cursor-shaped
//      events, so every existing log reader (usage, result text, auth/usage-cap classification,
//      activity strip) works unchanged.
//
// Muse cannot disable `cron_*` (NOT-177). The tool activity is checked here after the fact and
// surfaced as `cronCalls`; the effect turns that into a `muse_cron_used` escalation. It detects,
// it does not prevent.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MUSE_CODE_CONTRIBUTOR_MODEL } from "@agent-dealer/shared";
import { resolveMuseAuthFile, resolveMuseBin } from "../cli-env.js";
import { ensureWorktreeExcluded } from "../adapters/worktree-exclude.js";
import { buildMuseDeveloperInvocation } from "../runners/muse-code-args.js";
import { buildMuseDeveloperSettings } from "../runners/muse-code-settings.js";
import {
  normalizeMuseRun,
  parseMuseRun,
  type MuseFailure,
  type MuseUsage,
} from "../runners/muse-code-jsonl.js";
import { runMuseServeTurn } from "../runners/muse-serve-session.js";
import { spawnCli } from "../runners/spawn-cli.js";
import type { DeveloperSpawnInput, DeveloperSpawnResult } from "./spawn.js";

/**
 * NOT-270: execution lane selection. Default is the server-owned serve host
 * (real turns through it are the NOT-269 precondition for 5H/1W capacity).
 * `AGENT_DEALER_MUSE_RUNNER=exec` forces the legacy `muse exec` subprocess
 * lane — the operator escape hatch if the serve lane ever misbehaves in
 * production (capacity then reads honest N/A until serve runs again).
 */
function museServeLaneEnabled(): boolean {
  return process.env.AGENT_DEALER_MUSE_RUNNER !== "exec";
}

/** Worktree-relative home of every per-attempt Muse config/data dir. */
export const MUSE_ATTEMPT_ROOT = ".dealer-muse";

/**
 * Step cap when the profile sets no `maxTurns`. High on purpose (the PoC's value): the developer
 * wall-clock timeout is the real limit, the cap only stops a runaway loop.
 */
export const DEFAULT_MUSE_MAX_MODEL_STEPS = 300;

/** Muse cannot disable these; any call in a session's tool activity fails it as `muse_cron_used`. */
const CRON_TOOL_RE = /^cron_(create|list|delete)$/;

const STDERR_MARKER = "\n--- stderr ---\n";

export interface MuseSessionSummary {
  /** Caller-chosen id passed as `--session-id`; names the on-disk session log. */
  museSessionId: string;
  /** The model the server confirmed, not the one requested; null when it never did. */
  confirmedModel: string | null;
  usage: MuseUsage;
  /** Non-null means the session is not a success whatever the exit code said. */
  failure: MuseFailure | null;
  /** `cron_*` tool names seen in the session's tool activity, in order. */
  cronCalls: string[];
  /** More than one run on stdout means something (e.g. a cron job) started a run in this process. */
  runCount: number;
  /** Where the untouched stdout was archived; null when the archive could not be written. */
  rawLogPath: string | null;
}

/** `sessions/YYYY/MM/DD/<session-id>/session.jsonl` under the attempt's data dir, if present. */
function readSessionLog(dataDir: string, museSessionId: string): string | undefined {
  const root = path.join(dataDir, "muse", "sessions");
  const visit = (dir: string, depth: number): string | undefined => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = path.join(dir, e.name);
      if (e.name === museSessionId) {
        try {
          return fs.readFileSync(path.join(child, "session.jsonl"), "utf8");
        } catch {
          return undefined;
        }
      }
      if (depth < 4) {
        const found = visit(child, depth + 1);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return visit(root, 0);
}

function prepareAttemptDirs(worktreePath: string): { root: string; configHome: string; dataHome: string } {
  ensureWorktreeExcluded(worktreePath, `/${MUSE_ATTEMPT_ROOT}/`);
  const root = path.join(worktreePath, MUSE_ATTEMPT_ROOT, randomUUID());
  const configHome = path.join(root, "config");
  const dataHome = path.join(root, "data");
  fs.mkdirSync(path.join(configHome, "muse"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(dataHome, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by the umask; the dirs hold a login symlink and the session log.
  fs.chmodSync(root, 0o700);
  fs.chmodSync(configHome, 0o700);
  fs.chmodSync(dataHome, 0o700);
  fs.writeFileSync(
    path.join(configHome, "muse", "settings.json"),
    JSON.stringify(buildMuseDeveloperSettings(), null, 2) + "\n",
    { mode: 0o600 }
  );
  // Linked, never read or copied. Absent when the operator authenticates with META_API_KEY.
  const auth = resolveMuseAuthFile();
  if (fs.existsSync(auth)) fs.symlinkSync(auth, path.join(configHome, "muse", "auth.json"));
  return { root, configHome, dataHome };
}

function removeAttemptDirs(worktreePath: string, root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
  try {
    fs.rmdirSync(path.join(worktreePath, MUSE_ATTEMPT_ROOT)); // only when no sibling attempt remains
  } catch {
    // not empty or already gone
  }
}

function splitSpawnLog(raw: string): { stdout: string; stderr: string } {
  const idx = raw.indexOf(STDERR_MARKER);
  return idx < 0
    ? { stdout: raw, stderr: "" }
    : { stdout: raw.slice(0, idx), stderr: raw.slice(idx + STDERR_MARKER.length) };
}

/**
 * NOT-270: reuse real Dealer Muse work as the observation opportunity. After
 * a genuine Muse session ends, kick one bounded, best-effort refresh
 * through the server-owned serve host — the proven safe point for the final
 * `usage/read`. This deliberately bypasses the GET-route throttle
 * (`maybeRefreshMuseCapacityFromHost` shares it): the final read at the
 * safe point is contractual, not opportunistic — a recent Agents-page poll
 * must never skip it. This creates no model turn of its own (the capacity
 * client only ever sends the read-only handshake/`usage/read` allowlist)
 * and never affects the session result. Serve-lane turns observed the host,
 * so this hook is the final read that populates 5H/1W; after an exec-lane
 * fallback the host stays unobserved by construction (the NOT-269
 * structural precondition) and the read stays honest N/A with last-good
 * rows preserved.
 */
function refreshMuseCapacityAfterSession(): void {
  void (async () => {
    try {
      const [{ configuredCapacityRuntimes }, { refreshMuseCapacityFromHost }] =
        await Promise.all([import("../capacity/service.js"), import("../capacity/muse-host.js")]);
      if (!configuredCapacityRuntimes().includes("muse_code")) return;
      await refreshMuseCapacityFromHost();
    } catch {
      // Best-effort: capacity must never break or delay a session result.
    }
  })();
}

/**
 * NOT-270: run the real developer turn through the server-owned serve host.
 * Returns null when no turn was admitted (host unavailable, session/start
 * or turn/start rejected) — the caller then runs the legacy `muse exec`
 * lane. Never returns null after admission: an admitted turn is real work
 * and its verdict is reported honestly, never retried on the other lane.
 *
 * The serve lane needs no per-attempt XDG config/data dirs: the host runs
 * under its own server-owned home (`prepareMuseServeHome` in
 * capacity/muse-host.ts — same worker settings as the exec lane's
 * per-attempt settings.json plus a symlink to the ambient login, so runner
 * and capacity can never diverge on identity or posture). `onSpawn` is
 * deliberately not called: there is no per-attempt pid to persist, and
 * recovery must never treat the shared host as an attempt process.
 */
async function runMuseServeLane(
  input: DeveloperSpawnInput & { logPath: string },
  model: string,
  onAdmitted: () => void
): Promise<DeveloperSpawnResult | null> {
  const { getMuseCapacityHost } = await import("../capacity/muse-host.js");
  // Only this call may fall back: it resolves `admitted:false` (or throws)
  // strictly before any model work starts. Everything below runs after
  // admission — the caller's no-double-execution rule (via onAdmitted)
  // keeps those errors loud instead of falling back to exec.
  const turn = await runMuseServeTurn({
    host: getMuseCapacityHost(),
    prompt: input.prompt,
    model,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    onAdmitted: () => onAdmitted(),
  });
  if (!turn.admitted) return null;

  const cronCalls = turn.tools
    .map((t) => t.name)
    .filter((n): n is string => n !== null && CRON_TOOL_RE.test(n));
  const summary: MuseSessionSummary = {
    museSessionId: turn.sessionId ?? randomUUID(),
    confirmedModel: turn.confirmedModel,
    usage: turn.usage,
    failure: turn.failure,
    cronCalls,
    runCount: 1,
    rawLogPath: null,
  };

  // Same normalized evidence both lanes write: the raw folded history, then
  // the Claude/Cursor-shaped stream every existing log reader consumes.
  const rawLogPath = `${input.logPath.replace(/\.ndjson$/, "")}.muse-raw.jsonl`;
  try {
    fs.writeFileSync(rawLogPath, `${turn.viewItems.map((i) => JSON.stringify(i)).join("\n")}\n`);
    summary.rawLogPath = rawLogPath;
  } catch {
    // evidence copy is best-effort; the normalized log below still carries the outcome
  }
  const events = normalizeMuseRun({
    sessionId: summary.museSessionId,
    confirmedModel: turn.confirmedModel,
    tools: turn.tools,
    finalText: turn.finalText,
    usage: turn.usage,
    failure: turn.failure,
  }).map((e) =>
    e.type === "result" ? { ...e, muse: { ...summary, usage: turn.usage } } : e
  );
  fs.writeFileSync(input.logPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);

  // The real session above is the observation opportunity: kick the
  // best-effort capacity refresh (no synthetic turn, never throws, never
  // blocks this result).
  refreshMuseCapacityAfterSession();

  // A failed session must not read as success. 124 mirrors spawn-cli's
  // timeout exit so timeout handling downstream sees the same signal.
  const exitCode = turn.timedOut ? 124 : turn.failure ? 1 : turn.terminal === "completed" ? 0 : 1;
  return {
    exitCode,
    transcript: turn.finalText ?? "",
    logPath: input.logPath,
    timedOut: turn.timedOut,
    muse: summary,
  };
}

export async function runMuseDeveloperSession(
  input: DeveloperSpawnInput & {
    logPath: string;
    maxModelSteps?: number;
    /**
     * NOT-277: skip the shared serve host and spawn the on-disk binary. The capability probe
     * needs this — a long-lived host may still be the build from before an auto-update.
     */
    execLaneOnly?: boolean;
  }
): Promise<DeveloperSpawnResult> {
  const model = input.model ?? MUSE_CODE_CONTRIBUTOR_MODEL;
  const museSessionId = randomUUID();

  // Serve-first: real turns through the owned host observe it (NOT-269
  // precondition for 5H/1W). Pre-admission failure falls back to exec; an
  // admitted turn never falls back — its errors propagate loudly instead of
  // executing the work a second time on the exec lane.
  // `AGENT_DEALER_MUSE_RUNNER=exec` skips the serve lane entirely
  // (operator escape hatch).
  if (museServeLaneEnabled() && !input.execLaneOnly) {
    let admitted = false;
    try {
      const served = await runMuseServeLane(input, model, () => {
        admitted = true;
      });
      if (served) return served;
    } catch (err) {
      if (admitted) throw err;
      // Pre-admission serve-lane error: fall through to the exec lane below.
    }
  }
  const invocation = buildMuseDeveloperInvocation({
    model,
    maxModelSteps: input.maxModelSteps ?? DEFAULT_MUSE_MAX_MODEL_STEPS,
    sessionId: museSessionId,
    prompt: input.prompt,
  });
  const { logPath } = input;

  const dirs = prepareAttemptDirs(input.cwd);
  let spawned: { exitCode: number; transcript: string; timedOut: boolean };
  let sessionLog: string | undefined;
  try {
    spawned = await spawnCli(input.sessionId, resolveMuseBin(), invocation.args, input.cwd, {
      logPath,
      timeoutMs: input.timeoutMs,
      env: { ...invocation.env, XDG_CONFIG_HOME: dirs.configHome, XDG_DATA_HOME: dirs.dataHome },
      signal: input.signal,
      onSpawn: input.onSpawn,
    });
    sessionLog = readSessionLog(dirs.dataHome, museSessionId);
  } finally {
    removeAttemptDirs(input.cwd, dirs.root);
  }

  const rawLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : spawned.transcript;
  const { stdout, stderr } = splitSpawnLog(rawLog);
  const run = parseMuseRun({
    stdout,
    stderr,
    exitCode: spawned.timedOut ? null : spawned.exitCode,
    sessionLog,
    expectedModel: model,
  });
  const cronCalls = run.tools.map((t) => t.name).filter((n): n is string => n !== null && CRON_TOOL_RE.test(n));

  const summary: MuseSessionSummary = {
    museSessionId,
    confirmedModel: run.confirmedModel,
    usage: run.usage,
    failure: run.failure,
    cronCalls,
    runCount: run.runCount,
    rawLogPath: null,
  };

  // The raw envelopes stay as evidence; the log path every reader knows becomes the normalized stream.
  const rawLogPath = `${logPath.replace(/\.ndjson$/, "")}.muse-raw.jsonl`;
  try {
    fs.writeFileSync(rawLogPath, rawLog);
    summary.rawLogPath = rawLogPath;
  } catch {
    // evidence copy is best-effort; the normalized log below still carries the outcome
  }
  const events = run.events.map((e) =>
    e.type === "result" ? { ...e, muse: { ...summary, usage: run.usage } } : e
  );
  fs.writeFileSync(
    logPath,
    `${events.map((e) => JSON.stringify(e)).join("\n")}\n${stderr.trim() ? `${STDERR_MARKER}${stderr}` : ""}`
  );

  // The real session above is the observation opportunity: kick the
  // best-effort capacity refresh (no synthetic turn, never throws, never
  // blocks this result).
  refreshMuseCapacityAfterSession();

  return {
    // A failed session must not read as success just because Muse exited 0 (wrong model, no terminal event).
    exitCode: run.failure && spawned.exitCode === 0 ? 1 : spawned.exitCode,
    transcript: run.finalText ?? "",
    logPath,
    timedOut: spawned.timedOut,
    muse: summary,
  };
}
