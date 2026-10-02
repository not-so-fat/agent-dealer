// packages/server/src/runners/muse-serve-session.ts
//
// NOT-270: run a Muse turn through a caller-owned `muse serve` host (the
// NOT-269 proven lifecycle). Only a host that
// observes the account's provider traffic can answer `usage/read`, so the
// observation opportunity is a `session/start` + `turn/start` on that host.
// Production callers use this for genuine Dealer developer work and, when
// capacity has been unavailable for an hour, the dedicated bounded capacity
// probe. The capacity probe owns a separate restricted host and shuts it down
// after its final `usage/read`.
//
// Wire contract (stable MSP, Muse 1.4.x):
//   session/start {commandId UUIDv7, workspaceRoot, modelId, approvalMode}
//   turn/start    {commandId UUIDv7, sessionId, input:[{type:"text",text}]}
//   await         turn/completed {sessionId, terminal, usage, error?}
//   session/read  {sessionId, excludeItems:false} for transcript + tools
//   turn/cancel   on timeout/abort only
// Forbidden on this lane (asserted by the host): `session/resume`
// (state-changing, carries no usage — NOT-269 leg 2), `turn/steer`,
// approval writes. A capacity read never touches this lane.
//
// Posture vs `muse exec` (NOT-270 scope decision, recorded in
// capacity/muse-host.ts): the decision accepts exactly two gaps —
// `--disable-web-tools` and `--no-foreign-personal-context` have no wire-
// or host-level equivalent in this Muse version (1.4.0). Network sandbox
// parity is exact (the owned host starts with `--sandbox-network
// restricted`, the same constant every exec invocation passes) and worker
// posture matches via the host's server-owned config home (no MCP servers,
// no subagents/workflows/reminders, same as the exec per-attempt settings).
// Known deltas OUTSIDE the recorded decision (not accepted — need product
// sign-off or a wire equivalent): approvalMode `denyUnmatched` stands in
// for `--approval-mode never` (the wire enum has no `never`;
// never-prompts behavior unverified live), and `--approval-judge off` /
// `--max-model-steps` have no wire equivalent at all — a runaway loop is
// bounded only by the attempt wall-clock timeout + `turn/cancel` here.
// Re-verify all of the above with a free `--provider echo` session/turn;
// the production smoke check on Muse 1.4.x remains.
//
// Admission rule: anything that fails BEFORE the turn is admitted
// (host unavailable, session/start rejected, turn/start rejected) returns
// `admitted:false` having started no model work — the caller falls back to
// the legacy `muse exec` subprocess. After admission there is no fallback:
// the turn is real, billable work and its verdict is reported honestly.

import type { MuseCapacityHost, MuseHostMessage } from "../capacity/muse-host.js";
import { museUuidv7 } from "../capacity/muse.js";
import type { MuseFailure, MuseToolActivity, MuseUsage } from "./muse-code-jsonl.js";

export const MUSE_SERVE_APPROVAL_MODE = "denyUnmatched";

/** Monotonic suffix so concurrent turns never share a JSON-RPC request id. */
let serveReqSeq = 0;

function serveReqId(prefix: string): string {
  serveReqSeq += 1;
  return `muse-${prefix}-${Date.now()}-${serveReqSeq}`;
}

export interface MuseServeTurnInput {
  /** The caller-owned host; usage must be read back from this same host. */
  host: MuseCapacityHost;
  /** Dealer developer prompt or fixed capacity-probe prompt. Never empty. */
  prompt: string;
  /** Explicit model id, passed as session `modelId`. */
  model: string;
  /** Attempt worktree path, passed as `workspaceRoot`. */
  cwd: string;
  /** Wall-clock bound for the whole turn (attempt timeout). */
  timeoutMs: number;
  /** Attempt abort: cancels the turn, never falls back. */
  signal?: AbortSignal;
  /** Per-RPC bound (default 30 s, never more than timeoutMs). */
  rpcTimeoutMs?: number;
  /**
   * Invoked synchronously the moment the turn is admitted (turn/start
   * acked). The caller uses it to arm the no-double-execution rule: after
   * this fires, an error must fail loudly, never fall back to exec.
   */
  onAdmitted?: (sessionId: string) => void;
}

export interface MuseServeTurnResult {
  /** False when no turn was admitted — no model work started, exec fallback allowed. */
  admitted: boolean;
  sessionId: string | null;
  terminal: "completed" | "failed" | "cancelled" | null;
  /** Concatenated `agentMessage` texts for the turn; null when none committed. */
  finalText: string | null;
  /** The host-confirmed model id; null when the host never confirmed one. */
  confirmedModel: string | null;
  tools: MuseToolActivity[];
  usage: MuseUsage;
  failure: MuseFailure | null;
  timedOut: boolean;
  /** Turn durationMs from `turn/completed`, when measured. */
  durationMs: number | null;
  /** Folded history items for raw-log evidence (may be empty). */
  viewItems: unknown[];
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const AUTH_RE =
  /login is no longer valid|authentication failed|missing \w+ credentials|api key .*rejected|unauthenticated|unauthorized|unauthori[sz]ed|not (signed|logged) in|sign in|\b401\b|\b403\b|forbidden|authRequired/i;
const USAGE_CAP_RE = /rate[\s_-]*limit|usage[\s_-]*limit|quota|\b429\b|rate_limited/i;
const STEPS_RE = /stepLimit|did not reach a terminal state within \d+ step/i;

function nullUsage(): MuseUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    modelDurationMs: null,
    costUsd: null,
  };
}

function usageFromTokenUsage(u: unknown, durationMs: number | null): MuseUsage {
  const base = nullUsage();
  const r = asRecord(u);
  if (!r) return { ...base, modelDurationMs: durationMs };
  return {
    inputTokens: asFiniteNumber(r.inputTokens),
    outputTokens: asFiniteNumber(r.outputTokens),
    cacheReadTokens: asFiniteNumber(r.cacheReadTokens),
    cacheWriteTokens: asFiniteNumber(r.cacheWriteTokens),
    reasoningTokens: asFiniteNumber(r.reasoningTokens),
    modelDurationMs: durationMs,
    costUsd: null,
  };
}

function classifyTurnError(kind: unknown, message: unknown): MuseFailure {
  const k = typeof kind === "string" ? kind : "";
  const m = typeof message === "string" && message ? message : k || "turn failed";
  const text = `${k} ${m}`;
  if (STEPS_RE.test(text)) return { kind: "max_steps", message: m.slice(0, 500) };
  if (AUTH_RE.test(text)) return { kind: "auth", message: m.slice(0, 500) };
  if (USAGE_CAP_RE.test(text)) return { kind: "usage_cap", message: m.slice(0, 500) };
  return { kind: "other", message: m.slice(0, 500) };
}

function unadmitted(): MuseServeTurnResult {
  return {
    admitted: false,
    sessionId: null,
    terminal: null,
    finalText: null,
    confirmedModel: null,
    tools: [],
    usage: nullUsage(),
    failure: null,
    timedOut: false,
    durationMs: null,
    viewItems: [],
  };
}

/**
 * Fold `session/read` history items into transcript/tools/confirmed-model.
 * Unknown kinds are ignored (schema says clients must render them
 * generically; the runner only needs text + tool names). Items from other
 * turns are skipped when `turnId` is present.
 */
export function foldServeViewItems(
  items: unknown,
  turnId: string | null
): { finalText: string | null; tools: MuseToolActivity[] } {
  const texts: string[] = [];
  const tools: MuseToolActivity[] = [];
  if (!Array.isArray(items)) return { finalText: null, tools };
  for (const raw of items) {
    const it = asRecord(raw);
    if (!it) continue;
    if (turnId !== null && it.turnId !== undefined && it.turnId !== turnId) continue;
    if (typeof it.kind !== "string") continue;
    if (it.kind === "agentMessage") {
      const t = asString(it.text);
      if (t) texts.push(t);
    } else if (it.kind === "toolCall") {
      const name = asString(it.tool);
      const callId = asString(it.callId) ?? `tool-${tools.length}`;
      const failed =
        it.failureKind !== undefined ||
        it.failureReason !== undefined ||
        it.status === "failed";
      tools.push({
        callId,
        name: name ?? null,
        outcome: it.status === "inProgress" ? null : failed ? "failure" : "success",
        error: asString(it.failureReason) ?? null,
        // NOT-307: the serve turn items carry no per-tool times; exec-lane arrival
        // stamping does not apply here, so these stay unstamped (no `ts` fallback
        // is passed for this lane either).
        startedAt: null,
        durationMs: null,
      });
    }
  }
  const finalText = texts.length > 0 ? texts.join("\n") : null;
  return { finalText, tools };
}

function confirmedModelFromSession(session: unknown): string | null {
  const r = asRecord(session);
  if (!r) return null;
  return asString(r.modelId) ?? null;
}

export async function runMuseServeTurn(input: MuseServeTurnInput): Promise<MuseServeTurnResult> {
  if (!input.model.trim()) throw new Error("muse: model must be set explicitly");
  if (!input.prompt.trim()) throw new Error("muse: prompt must not be empty");
  if (input.prompt.startsWith("-")) throw new Error("muse: prompt must not start with '-'");
  const { host } = input;
  const rpcTimeoutMs = Math.min(input.rpcTimeoutMs ?? 30_000, input.timeoutMs);
  const started = await host.ensureStarted();
  if (!started) return unadmitted();

  const startReply = await host.execRequest(
    serveReqId("serve-session"),
    "session/start",
    {
      commandId: museUuidv7(),
      workspaceRoot: input.cwd,
      modelId: input.model,
      approvalMode: MUSE_SERVE_APPROVAL_MODE,
    },
    rpcTimeoutMs
  );
  if (!startReply || startReply.error) return unadmitted();
  const session = asRecord(startReply.result)?.session;
  const sessionId = asRecord(session)?.sessionId;
  if (typeof sessionId !== "string" || !sessionId) return unadmitted();
  let confirmedModel = confirmedModelFromSession(session);

  const turnReply = await host.execRequest(
    serveReqId("serve-turn"),
    "turn/start",
    {
      commandId: museUuidv7(),
      sessionId,
      input: [{ type: "text", text: input.prompt }],
    },
    rpcTimeoutMs
  );
  if (!turnReply || turnReply.error) return unadmitted();
  // The turn is admitted from here: real, billable work may be running.
  // No exec fallback past this point — every exit below reports honestly.
  try {
    input.onAdmitted?.(sessionId);
  } catch {
    // The admission flag is advisory; a throwing listener must not break the turn.
  }
  const turnId = asString(asRecord(turnReply.result)?.turnId) ?? null;

  let aborted = false;
  const onAbort = () => {
    aborted = true;
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const deadlineMs = Date.now() + input.timeoutMs;
  let completed: MuseHostMessage | null = null;
  try {
    while (completed === null) {
      if (aborted) break;
      // Host death resolves waiters null — re-subscribing on a dead host
      // would spin until the deadline, so stop waiting and settle below.
      if (!host.isConnected()) break;
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) break;
      completed = await host.waitForHostNotification(
        (m) => m.method === "turn/completed" && asRecord(m.params)?.sessionId === sessionId,
        Math.min(remaining, 30_000)
      );
      // waitForHostNotification resolves null on chunk timeout too — loop
      // until the turn completes or the deadline passes. (Subscribe happens
      // microseconds after the turn/start ack while a real completion takes
      // seconds, so no completion can slip between admit and subscribe.)
    }
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
  }

  const timedOut = completed === null && !aborted;
  if (completed === null) {
    // Timeout or abort: cancel the turn, then take whatever terminal the
    // host settles on (usually `cancelled`) as the honest record.
    await host.cancelExecTurn(sessionId, turnId ?? undefined);
    completed = await host.waitForHostNotification(
      (m) => m.method === "turn/completed" && asRecord(m.params)?.sessionId === sessionId,
      10_000
    );
  }

  const params = asRecord(completed?.params);
  const terminalRaw = asString(params?.terminal);
  const terminal =
    terminalRaw === "completed" || terminalRaw === "failed" || terminalRaw === "cancelled"
      ? terminalRaw
      : null;
  const turnError = asRecord(params?.error);
  const durationMs = asFiniteNumber(params?.durationMs);
  const usage = usageFromTokenUsage(params?.usage, durationMs);

  // Folded history for transcript + tool activity (best-effort: a turn whose
  // history cannot be read still reports its terminal + usage honestly).
  let finalText: string | null = null;
  let tools: MuseToolActivity[] = [];
  let viewItems: unknown[] = [];
  try {
    const readReply = await host.execRequest(
      serveReqId("serve-read"),
      "session/read",
      { sessionId, excludeItems: false },
      rpcTimeoutMs
    );
    const readResult = asRecord(readReply?.result);
    const readSession = readResult?.session;
    confirmedModel = confirmedModelFromSession(readSession) ?? confirmedModel;
    const history = asRecord(readResult?.history);
    const items = history?.items;
    if (Array.isArray(items)) viewItems = items;
    const folded = foldServeViewItems(items, turnId);
    finalText = folded.finalText;
    tools = folded.tools;
  } catch {
    // Best-effort: keep terminal + usage.
  }

  let failure: MuseFailure | null = null;
  if (aborted && terminal !== "completed") {
    failure = { kind: "other", message: "aborted" };
  } else if (terminal === "failed") {
    failure = classifyTurnError(turnError?.kind, turnError?.message);
  } else if (terminal === "cancelled") {
    failure = timedOut
      ? { kind: "other", message: "turn timed out and was cancelled" }
      : { kind: "other", message: `turn cancelled${asString(params?.reason) ? `: ${asString(params?.reason)}` : ""}`.slice(0, 500) };
  } else if (terminal === "completed") {
    const wrong = confirmedModel !== null && confirmedModel !== input.model;
    if (wrong) {
      failure = {
        kind: "model_mismatch",
        message: `configured ${input.model}, server confirmed ${confirmedModel}`.slice(0, 500),
      };
    } else if (confirmedModel === null) {
      failure = { kind: "model_mismatch", message: `server did not confirm model ${input.model}` };
    }
  } else {
    // No completion observed even after cancel (host died mid-turn).
    failure = timedOut
      ? { kind: "other", message: "turn timed out with no completion observed" }
      : { kind: "other", message: "no turn completion observed" };
  }

  return {
    admitted: true,
    sessionId,
    terminal,
    finalText: finalText === "" ? null : finalText,
    confirmedModel,
    tools,
    usage,
    failure,
    timedOut,
    durationMs,
    viewItems,
  };
}
