// NOT-179: parse `muse exec --json` output (NOT-177 pinned contract, Muse Code 1.3.0-R3401.1) into
// a structured run result and Agent Dealer's Claude/Cursor-shaped normalized events. Pure and
// separate from the Codex/Claude/Cursor parsers.
//
// What this module does NOT decide: exit 0 and `run.terminal.completed` mean only that the turn
// ended, never that the task succeeded (git diff, tests and review state decide that). Cancellation,
// signal exits and resume are out of scope; a signal exit with no terminal event is reported as
// `other`, not as a cancellation.

type StreamEvent = Record<string, unknown>;

export type MuseFailureKind =
  | "auth"
  | "usage_cap"
  | "max_steps"
  | "malformed_stream"
  | "model_mismatch"
  | "other";

export interface MuseFailure {
  kind: MuseFailureKind;
  message: string;
}

export interface MuseToolActivity {
  callId: string;
  name: string | null;
  /** From `tool.result.correlation_facts.outcome`; null while no result was seen. */
  outcome: "success" | "failure" | null;
  error: string | null;
  /**
   * NOT-307: Dealer-observed ISO time of the intent line on stdout; null when the
   * stream gave nothing usable (see `MuseRunInput.lineTs` / envelope time below).
   */
  startedAt: string | null;
  /**
   * NOT-307: intent-line arrival → result-line arrival in milliseconds. Present only
   * when a matching result was seen AND both endpoints have usable times — a bare
   * intent (still running at kill time) carries no duration.
   */
  durationMs: number | null;
}

/** Every field is null when Muse did not report it. Nothing is derived from the exit code. */
export interface MuseUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  /** Summed model-call time from the session log, not wall-clock. */
  modelDurationMs: number | null;
  /** Muse reports no cost or credit figure anywhere (NOT-177), so this is always null. */
  costUsd: null;
}

export interface MuseRunInput {
  /** `muse exec --json` stdout, one envelope per line. */
  stdout: string;
  /**
   * NOT-307: Dealer-observed arrival epoch milliseconds parallel to `stdout` lines
   * (`stdout.split("\n")[i]` arrived at `lineTs[i]`), collected by `spawnCli`'s
   * `onStdoutLine`. First timing source: the stream's own `recorded_at` is
   * batch-stamped (a whole real session shares one ~40ms window), so it is used
   * only when no arrival time exists for the line. Shorter arrays and null entries
   * fall through to the next source; absent entirely means envelope time or `now`.
   */
  lineTs?: Array<number | null>;
  /**
   * NOT-307: ISO fallback stamped on normalized events that have no stream-derived
   * time. `muse-spawn` passes the log-write time so every written event carries a
   * `ts`; omitted (bare parser calls, fixtures) means unstamped events stay
   * byte-stable.
   */
  now?: string;
  stderr?: string;
  exitCode: number | null;
  /**
   * Contents of `$XDG_DATA_HOME/muse/sessions/YYYY/MM/DD/<session-id>/session.jsonl`. Usage and the
   * server-confirmed model exist only there, not on stdout.
   */
  sessionLog?: string;
  /** The `--model` the run was launched with. */
  expectedModel: string;
}

export interface MuseRunResult {
  sessionId: string | null;
  /** Terminal of the primary (first) run in the stream; null when the stream never reached one. */
  terminal: "completed" | "failed" | null;
  /** `run.terminal.completed.text` of the primary run: model prose, not a verified result. */
  finalText: string | null;
  /**
   * Distinct runs observed on stdout, terminated or not. More than one means something else (e.g. a
   * cron job) started a run inside this process.
   */
  runCount: number;
  confirmedModel: string | null;
  tools: MuseToolActivity[];
  usage: MuseUsage;
  /** A `rate_limited` / HTTP 429 retry facet was seen on stdout for the primary run. */
  rateLimited: boolean;
  failure: MuseFailure | null;
  exitCode: number | null;
  /** Claude/Cursor-shaped events (`system` init, `tool_call`, `assistant`, `result`). */
  events: StreamEvent[];
}

const AUTH_RE =
  /login is no longer valid|authentication failed|missing \w+ credentials|api key .*rejected|unauthori[sz]ed|\b401\b/i;
const MAX_STEPS_RE = /did not reach a terminal state within \d+ step/i;
const USAGE_CAP_RE = /rate[\s_-]*limit|usage[\s_-]*limit|quota|\b429\b/i;
const ERROR_TEXT_MAX = 500;

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function cap(s: string): string {
  return s.length > ERROR_TEXT_MAX ? `${s.slice(0, ERROR_TEXT_MAX)}…` : s;
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0] ?? "";
}

interface Envelope {
  streamKind?: string;
  streamId?: string;
  payloadType: string;
  payload: Record<string, unknown>;
  /** Raw `recorded_at` value as the stream sent it (number or string), if any. */
  recordedAt: unknown;
  /** Dealer-observed arrival epoch ms of this envelope's stdout line, if known. */
  lineTs: number | null;
}

function toEnvelope(o: unknown): Omit<Envelope, "recordedAt" | "lineTs"> | undefined {
  const rec = asRecord(o);
  const payloadType = str(rec?.payload_type);
  const payload = asRecord(rec?.payload);
  if (!rec || payloadType === undefined || !payload) return undefined;
  const stream = asRecord(rec.stream);
  return {
    streamKind: str(stream?.kind),
    streamId: str(stream?.id),
    payloadType,
    payload,
  };
}

/** Envelopes plus the count of non-empty lines that were not a JSON envelope. */
function readEnvelopes(raw: string, lineTs?: Array<number | null>): { envelopes: Envelope[]; malformed: number } {
  const envelopes: Envelope[] = [];
  let malformed = 0;
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      malformed++;
      continue;
    }
    const env = toEnvelope(parsed);
    if (env) {
      const at = lineTs && i < lineTs.length ? lineTs[i] : null;
      envelopes.push({
        ...env,
        recordedAt: (parsed as Record<string, unknown>).recorded_at ?? null,
        lineTs: typeof at === "number" && Number.isFinite(at) ? at : null,
      });
    } else malformed++;
  }
  return { envelopes, malformed };
}

/**
 * NOT-307: usable event time for one envelope, epoch milliseconds. Dealer-observed
 * arrival first; the stream's own `recorded_at` only as a fallback, and only when
 * it parses — real sessions batch-stamp it (µs number, whole session in ~40ms),
 * fixtures redact it to `<ts>`. Numbers above 1e14 are microseconds, below are
 * milliseconds; strings go through Date.parse.
 */
function envelopeTimeMs(env: Envelope): number | null {
  if (env.lineTs !== null) return env.lineTs;
  const r = env.recordedAt;
  if (typeof r === "number" && Number.isFinite(r)) {
    return r > 1e14 ? Math.round(r / 1000) : Math.round(r);
  }
  if (typeof r === "string") {
    const ms = Date.parse(r);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function isoOf(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

interface ModelCompleted {
  runId: string | null;
  model: string | null;
  usage: Record<string, unknown> | undefined;
  durationMs: number | null;
}

/** Session-log lines are auxiliary: unparseable ones are skipped rather than failing the run. */
function readModelCompleted(sessionLog: string | undefined): ModelCompleted[] {
  if (!sessionLog) return [];
  const out: ModelCompleted[] = [];
  for (const env of readEnvelopes(sessionLog).envelopes) {
    if (env.payloadType !== "runtime.session") continue;
    const event = asRecord(env.payload.event);
    if (event?.kind !== "model_completed") continue;
    out.push({
      runId: str(env.payload.run_id) ?? null,
      model: str(event.model) ?? null,
      usage: asRecord(event.usage),
      durationMs: num(event.duration_ms),
    });
  }
  return out;
}

/** An aggregate is unknown when any contributing call omitted the field: never under-report. */
function sumField(values: Array<number | null>): number | null {
  if (values.length === 0 || values.some((v) => v === null)) return null;
  return (values as number[]).reduce((a, b) => a + b, 0);
}

function usageFrom(calls: ModelCompleted[]): MuseUsage {
  const field = (key: string) => sumField(calls.map((c) => num(c.usage?.[key])));
  return {
    inputTokens: field("input_tokens"),
    outputTokens: field("output_tokens"),
    cacheReadTokens: field("cache_read_tokens"),
    cacheWriteTokens: field("cache_write_tokens"),
    reasoningTokens: field("reasoning_tokens"),
    modelDurationMs: sumField(calls.map((c) => c.durationMs)),
    costUsd: null,
  };
}

/** The run a stdout envelope belongs to (`payload.run_stream.id`), when it names one. */
function runIdOf(payload: Record<string, unknown>): string | undefined {
  const rs = asRecord(payload.run_stream);
  return rs?.kind === "run" ? str(rs.id) : undefined;
}

function hasRateLimitFacet(payload: Record<string, unknown>): boolean {
  const details = asRecord(asRecord(payload.event)?.details);
  const facets = details?.facets;
  if (!Array.isArray(facets)) return false;
  return facets.some((f) => {
    const facet = asRecord(f);
    return facet?.kind === "external_attempt" && (facet.error_kind === "rate_limited" || facet.http_status === 429);
  });
}

function classifyReason(reason: string): MuseFailure {
  const message = cap(reason || "muse run failed");
  if (AUTH_RE.test(reason)) return { kind: "auth", message };
  if (MAX_STEPS_RE.test(reason)) return { kind: "max_steps", message };
  if (USAGE_CAP_RE.test(reason)) return { kind: "usage_cap", message };
  return { kind: "other", message };
}

export function parseMuseRun(input: MuseRunInput): MuseRunResult {
  const { envelopes, malformed } = readEnvelopes(input.stdout, input.lineTs);
  const stderr = input.stderr ?? "";
  // A garbage `now` must never stamp garbage: only a parseable ISO string qualifies.
  const fallbackTs =
    typeof input.now === "string" && input.now && Number.isFinite(Date.parse(input.now))
      ? input.now
      : null;

  let sessionId: string | null = null;
  const tools = new Map<string, MuseToolActivity>();
  const toolByTask = new Map<string, string>();
  const terminals: Array<{ runId: string | undefined; terminal: "completed" | "failed"; text: string; reason: string }> =
    [];
  let rateLimited = false;
  // The first run seen is the primary one; a cron job may start further runs in the same process.
  let primaryRunId: string | null = null;
  const runIds = new Set<string>();

  // NOT-307: stream-derived per-event times. firstTs anchors the `system` event;
  // terminalTs anchors `assistant`/`result`; per-tool intent/result endpoints make
  // durationMs. All stay null when the stream gave nothing usable (fixtures redact
  // recorded_at, no lineTs) so unstamped output stays byte-stable.
  let firstTs: string | null = null;
  let terminalTs: string | null = null;
  const noteEnvelopeTime = (at: string | null) => {
    if (at !== null && firstTs === null) firstTs = at;
  };

  for (const env of envelopes) {
    const p = env.payload;
    if (sessionId === null && env.streamKind === "session" && env.streamId) sessionId = env.streamId;

    const runId = runIdOf(p);
    if (runId !== undefined) runIds.add(runId);
    if (primaryRunId === null) primaryRunId = runId ?? null;
    noteEnvelopeTime(isoOf(envelopeTimeMs(env)));

    if (env.payloadType === "run.terminal.completed" || env.payloadType === "run.terminal.failed") {
      const at = isoOf(envelopeTimeMs(env));
      if (at !== null && terminalTs === null) terminalTs = at;
      terminals.push({
        runId: runIdOf(p),
        terminal: env.payloadType === "run.terminal.completed" ? "completed" : "failed",
        text: str(p.text) ?? "",
        reason: str(p.reason) ?? "",
      });
    } else if (env.payloadType === "task.lifecycle.side_effect_intent") {
      const event = asRecord(p.event);
      const operation = str(event?.operation);
      const key = str(event?.idempotency_key);
      if (operation?.startsWith("tool:") && key?.startsWith("tool:")) {
        const callId = key.slice("tool:".length);
        const existing = tools.get(callId);
        tools.set(
          callId,
          existing ?? {
            callId,
            name: operation.slice("tool:".length),
            outcome: null,
            error: null,
            startedAt: isoOf(envelopeTimeMs(env)),
            durationMs: null,
          }
        );
        const taskId = str(event?.task_id);
        if (taskId) toolByTask.set(taskId, callId);
      }
    } else if (env.payloadType === "tool.result") {
      const callId = str(p.call_id);
      if (!callId) continue;
      const facts = asRecord(p.correlation_facts);
      const outcome = facts?.outcome === "success" || facts?.outcome === "failure" ? facts.outcome : null;
      const prev = tools.get(callId);
      const endMs = envelopeTimeMs(env);
      const startMs = prev?.startedAt ? Date.parse(prev.startedAt) : NaN;
      tools.set(callId, {
        callId,
        name: str(facts?.tool_name) ?? prev?.name ?? null,
        outcome,
        error: prev?.error ?? null,
        startedAt: prev?.startedAt ?? null,
        // Present only when the matching result arrived with both endpoints timed —
        // a bare intent (tool still running at kill time) carries no duration.
        durationMs:
          endMs !== null && Number.isFinite(startMs) && endMs >= startMs ? endMs - startMs : null,
      });
    } else if (env.payloadType === "task.lifecycle.failed") {
      const event = asRecord(p.event);
      const callId = toolByTask.get(str(event?.task_id) ?? "");
      const prev = callId ? tools.get(callId) : undefined;
      if (prev) prev.error = cap(str(event?.reason) ?? "");
    } else if (env.payloadType === "task.lifecycle.status" && hasRateLimitFacet(p)) {
      // Another run's 429 says nothing about the primary run; a facet naming no run is attributed to it.
      if (runId === undefined || runId === primaryRunId) rateLimited = true;
    }
  }

  // Terminals, model confirmation and usage are scoped to the primary run. With no run id on stdout
  // there is nothing to correlate against, so everything is accepted.
  const calls = readModelCompleted(input.sessionLog).filter(
    (c) => primaryRunId === null || c.runId === primaryRunId
  );
  const usage = usageFrom(calls);
  const confirmedModel = calls.find((c) => c.model !== null)?.model ?? null;
  const first = terminals.find((t) => primaryRunId === null || t.runId === primaryRunId);

  const failure = classify();

  function classify(): MuseFailure | null {
    if (malformed > 0) {
      return { kind: "malformed_stream", message: `${malformed} stdout line(s) were not muse JSON envelopes` };
    }
    // The configured-model check holds for whatever the primary run's terminal turned out to be.
    const wrong = calls.find((c) => c.model !== null && c.model !== input.expectedModel);
    if (wrong) {
      const detail = first?.terminal === "failed" ? `; run also failed: ${classifyReason(first.reason).message}` : "";
      return {
        kind: "model_mismatch",
        message: cap(`configured ${input.expectedModel}, server confirmed ${wrong.model}${detail}`),
      };
    }
    if (first?.terminal === "failed") return classifyReason(first.reason);
    if (!first) {
      if (rateLimited) return { kind: "usage_cap", message: "rate limited (429) and never reached a terminal event" };
      // Startup failures (no catalog, bad key) print to stderr with an empty stdout.
      if (AUTH_RE.test(stderr)) return { kind: "auth", message: cap(firstLine(stderr)) };
      if (USAGE_CAP_RE.test(stderr)) return { kind: "usage_cap", message: cap(firstLine(stderr)) };
      if (input.exitCode === 0) {
        return { kind: "malformed_stream", message: "muse exited 0 without a run.terminal event" };
      }
      return {
        kind: "other",
        message: cap(firstLine(stderr) || `muse exited ${input.exitCode ?? "without a status"} without a run.terminal event`),
      };
    }
    if (input.exitCode !== 0) {
      return { kind: "other", message: `run.terminal.completed but muse exited ${input.exitCode ?? "without a status"}` };
    }
    if (confirmedModel === null) {
      return { kind: "model_mismatch", message: `server did not confirm model ${input.expectedModel}` };
    }
    return null;
  }

  const toolList = [...tools.values()];
  const finalText = first?.terminal === "completed" ? first.text : null;

  return {
    sessionId,
    terminal: first?.terminal ?? null,
    finalText: finalText === "" ? null : finalText,
    // Without run ids on stdout there is nothing to count but the terminals.
    runCount: Math.max(runIds.size, terminals.length),
    confirmedModel,
    tools: toolList,
    usage,
    rateLimited,
    failure,
    exitCode: input.exitCode,
    events: normalizeMuseRun({
      sessionId,
      confirmedModel,
      tools: toolList,
      finalText,
      usage,
      failure,
      now: fallbackTs,
      firstTs,
      terminalTs,
    }),
  };
}

/**
 * NOT-270: shared by the exec parser above and the serve execution lane
 * (runners/muse-serve-session.ts) so both runners write byte-identical
 * normalized log evidence — every downstream log reader works unchanged
 * whichever lane ran the session.
 */
export function normalizeMuseRun(r: {
  sessionId: string | null;
  confirmedModel: string | null;
  tools: MuseToolActivity[];
  finalText: string | null;
  usage: MuseUsage;
  failure: MuseFailure | null;
  /**
   * NOT-307: ISO fallback for events with no stream-derived time (and the `system`
   * anchor when the stream's first envelope had none). When all three are absent,
   * events carry no `ts` — the byte-stable path for fixtures and bare parser calls.
   */
  now?: string | null;
  /** Stream-derived time of the first stdout envelope; anchors `system`. */
  firstTs?: string | null;
  /** Stream-derived time of the terminal envelope; anchors `assistant`/`result`. */
  terminalTs?: string | null;
}): StreamEvent[] {
  const out: StreamEvent[] = [];
  const at = (ts: string | null | undefined): Record<string, string> =>
    ts ? { ts } : r.now ? { ts: r.now } : {};
  if (r.sessionId) {
    out.push({
      type: "system",
      subtype: "init",
      session_id: r.sessionId,
      ...(r.confirmedModel ? { model: r.confirmedModel } : {}),
      ...at(r.firstTs ?? null),
    });
  }
  for (const t of r.tools)
    out.push({
      type: "tool_call",
      name: t.name ?? "unknown",
      ...at(t.startedAt),
      ...(t.durationMs !== null ? { durationMs: t.durationMs } : {}),
    });
  if (r.finalText) {
    out.push({
      type: "assistant",
      message: { content: [{ type: "text", text: r.finalText }] },
      ...at(r.terminalTs ?? null),
    });
  }

  const usage: Record<string, number> = {};
  if (r.usage.inputTokens !== null) usage.input_tokens = r.usage.inputTokens;
  if (r.usage.outputTokens !== null) usage.output_tokens = r.usage.outputTokens;
  if (r.usage.cacheReadTokens !== null) usage.cache_read_input_tokens = r.usage.cacheReadTokens;
  if (r.usage.cacheWriteTokens !== null) usage.cache_write_input_tokens = r.usage.cacheWriteTokens;

  out.push({
    type: "result",
    ...(r.failure ? { is_error: true, result: r.failure.message } : { result: r.finalText ?? "" }),
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
    ...at(r.terminalTs ?? null),
  });
  return out;
}
