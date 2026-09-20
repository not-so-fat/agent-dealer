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
  /** Terminal of the first run in the stream; null when the stream never reached one. */
  terminal: "completed" | "failed" | null;
  /** `run.terminal.completed.text` of the first run: model prose, not a verified result. */
  finalText: string | null;
  /** More than one means something else (e.g. a cron job) started a run inside this process. */
  runCount: number;
  confirmedModel: string | null;
  tools: MuseToolActivity[];
  usage: MuseUsage;
  /** A `rate_limited` / HTTP 429 retry facet was seen on stdout. */
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
}

function toEnvelope(o: unknown): Envelope | undefined {
  const rec = asRecord(o);
  const payloadType = str(rec?.payload_type);
  const payload = asRecord(rec?.payload);
  if (!rec || payloadType === undefined || !payload) return undefined;
  const stream = asRecord(rec.stream);
  return { streamKind: str(stream?.kind), streamId: str(stream?.id), payloadType, payload };
}

/** Envelopes plus the count of non-empty lines that were not a JSON envelope. */
function readEnvelopes(raw: string): { envelopes: Envelope[]; malformed: number } {
  const envelopes: Envelope[] = [];
  let malformed = 0;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      malformed++;
      continue;
    }
    const env = toEnvelope(parsed);
    if (env) envelopes.push(env);
    else malformed++;
  }
  return { envelopes, malformed };
}

interface ModelCompleted {
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
      model: str(event.model) ?? null,
      usage: asRecord(event.usage),
      durationMs: num(event.duration_ms),
    });
  }
  return out;
}

function sumField(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length > 0 ? present.reduce((a, b) => a + b, 0) : null;
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
  const { envelopes, malformed } = readEnvelopes(input.stdout);
  const stderr = input.stderr ?? "";

  let sessionId: string | null = null;
  const tools = new Map<string, MuseToolActivity>();
  const toolByTask = new Map<string, string>();
  const terminals: Array<{ terminal: "completed" | "failed"; text: string; reason: string }> = [];
  let rateLimited = false;

  for (const env of envelopes) {
    const p = env.payload;
    if (sessionId === null && env.streamKind === "session" && env.streamId) sessionId = env.streamId;

    if (env.payloadType === "run.terminal.completed" || env.payloadType === "run.terminal.failed") {
      terminals.push({
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
        tools.set(callId, existing ?? { callId, name: operation.slice("tool:".length), outcome: null, error: null });
        const taskId = str(event?.task_id);
        if (taskId) toolByTask.set(taskId, callId);
      }
    } else if (env.payloadType === "tool.result") {
      const callId = str(p.call_id);
      if (!callId) continue;
      const facts = asRecord(p.correlation_facts);
      const outcome = facts?.outcome === "success" || facts?.outcome === "failure" ? facts.outcome : null;
      const prev = tools.get(callId);
      tools.set(callId, {
        callId,
        name: str(facts?.tool_name) ?? prev?.name ?? null,
        outcome,
        error: prev?.error ?? null,
      });
    } else if (env.payloadType === "task.lifecycle.failed") {
      const event = asRecord(p.event);
      const callId = toolByTask.get(str(event?.task_id) ?? "");
      const prev = callId ? tools.get(callId) : undefined;
      if (prev) prev.error = cap(str(event?.reason) ?? "");
    } else if (env.payloadType === "task.lifecycle.status" && hasRateLimitFacet(p)) {
      rateLimited = true;
    }
  }

  const calls = readModelCompleted(input.sessionLog);
  const usage = usageFrom(calls);
  const confirmedModel = calls.find((c) => c.model !== null)?.model ?? null;
  const first = terminals[0];

  const failure = classify();

  function classify(): MuseFailure | null {
    if (malformed > 0) {
      return { kind: "malformed_stream", message: `${malformed} stdout line(s) were not muse JSON envelopes` };
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
    const wrong = calls.find((c) => c.model !== null && c.model !== input.expectedModel);
    if (wrong) {
      return { kind: "model_mismatch", message: `configured ${input.expectedModel}, server confirmed ${wrong.model}` };
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
    runCount: terminals.length,
    confirmedModel,
    tools: toolList,
    usage,
    rateLimited,
    failure,
    exitCode: input.exitCode,
    events: normalizeMuseRun({ sessionId, confirmedModel, tools: toolList, finalText, usage, failure }),
  };
}

function normalizeMuseRun(r: {
  sessionId: string | null;
  confirmedModel: string | null;
  tools: MuseToolActivity[];
  finalText: string | null;
  usage: MuseUsage;
  failure: MuseFailure | null;
}): StreamEvent[] {
  const out: StreamEvent[] = [];
  if (r.sessionId) {
    out.push({
      type: "system",
      subtype: "init",
      session_id: r.sessionId,
      ...(r.confirmedModel ? { model: r.confirmedModel } : {}),
    });
  }
  for (const t of r.tools) out.push({ type: "tool_call", name: t.name ?? "unknown" });
  if (r.finalText) {
    out.push({ type: "assistant", message: { content: [{ type: "text", text: r.finalText }] } });
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
  });
  return out;
}
