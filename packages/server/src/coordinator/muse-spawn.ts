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
import { parseMuseRun, type MuseFailure, type MuseUsage } from "../runners/muse-code-jsonl.js";
import { spawnCli } from "../runners/spawn-cli.js";
import type { DeveloperSpawnInput, DeveloperSpawnResult } from "./spawn.js";

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

export async function runMuseDeveloperSession(
  input: DeveloperSpawnInput & { logPath: string; maxModelSteps?: number }
): Promise<DeveloperSpawnResult> {
  const model = input.model ?? MUSE_CODE_CONTRIBUTOR_MODEL;
  const museSessionId = randomUUID();
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

  return {
    // A failed session must not read as success just because Muse exited 0 (wrong model, no terminal event).
    exitCode: run.failure && spawned.exitCode === 0 ? 1 : spawned.exitCode,
    transcript: run.finalText ?? "",
    logPath,
    timedOut: spawned.timedOut,
    muse: summary,
  };
}
