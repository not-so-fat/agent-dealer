#!/usr/bin/env node
// packages/server/src/capacity/fixtures/fake-muse-serve.mjs
//
// NOT-247: fake `muse serve` Session Protocol for tests. Speaks the stable
// MSP surface over stdio: the `initialize` handshake (with a `clientInfo`
// identity), then the `initialized` notification, then exactly one
// `usage/read` (or a failure mode), so adapter tests never touch a live
// provider, send a prompt, or consume tokens.
//
// NOT-263: the fake enforces the stable contract — it rejects the removed
// `--protocol` argv exactly like the shipped binary (`muse serve` takes no
// such flag), requires the handshake before `usage/read`, and serves the
// stable `usage.window` / `usage.weekly` field names.
//
// Env:
//   FAKE_MSP_MODE: full | custom-duration | partial-bad-weekly |
//     all-bad-windows | missing | auth-error | malformed | hang |
//     exit-nonzero | crash | no-method | persistent-full | persistent-missing |
//     exit-after-first-read | slow-term-full |
//     serve-turn-full | serve-turn-rejected | serve-session-start-error |
//     serve-turn-failed | serve-turn-hang
//
// Execution modes (NOT-270 serve lane): after the handshake they answer
// `session/start`, `turn/start`, `turn/cancel`, `session/read` with the
// stable shapes, emitting `usage/changed` + `turn/completed` after a short
// delay (the client subscribes microseconds after the turn/start ack while
// a real completion takes seconds — the delay models that ordering).
// `serve-turn-full` starts unobserved (`usage/read` → missing) and becomes
// observed once its turn completes. `serve-turn-rejected` errors turn/start
// (pre-admission); `serve-session-start-error` errors session/start;
// `serve-turn-failed` completes the turn as failed; `serve-turn-hang` acks
// the turn but never completes until `turn/cancel`.
//   FAKE_MSP_RECORD: path of a file to append one JSON line per received message
//   FAKE_MSP_RECORD_CONFIG: path to write one JSON line at startup with the
//     observed XDG homes, parsed settings.json, and auth-link state
//   FAKE_MSP_NOW_MS: fixed clock for deterministic resetsAtMs (default Date.now())
//
// `full` mirrors the stable shape: observedAtMs, tier, a rolling `window`
// (300 min) and a weekly window. A `usage/changed` notification precedes the
// read response so tests can assert notification consumption.
// `persistent-full` / `persistent-missing` answer every `usage/read` (the
// owned long-lived host reuses one connection across reads); the `served`
// once-only guard applies to one-shot modes only. `exit-after-first-read`
// serves one full read, then exits 0 to exercise transparent host restart.
// `slow-term-full` behaves like `persistent-full` but dies 500 ms after
// SIGTERM, so a test can restart the host first and prove the stale child's
// late `close` cannot kill its replacement.

import fs from "node:fs";
import path from "node:path";

// The shipped `muse serve` takes no `--protocol` flag: reject it with the
// same usage error and exit code 2 production reports.
if (process.argv.includes("--protocol")) {
  process.stderr.write("muse serve: unknown option --protocol\nusage: muse serve [OPTIONS]\n");
  process.exit(2);
}

const mode = process.env.FAKE_MSP_MODE ?? "full";
const recordPath = process.env.FAKE_MSP_RECORD;
const nowMs = Number(process.env.FAKE_MSP_NOW_MS ?? Date.now());

// NOT-270 serve-lane posture: the owned host must launch under a
// server-owned XDG home (worker settings + auth link), never the ambient
// operator config. When FAKE_MSP_RECORD_CONFIG is set, record the observed
// XDG homes plus the parsed settings.json and auth-link state at startup so
// tests can prove the launch env without a live binary.
if (process.env.FAKE_MSP_RECORD_CONFIG) {
  try {
    const configHome = process.env.XDG_CONFIG_HOME ?? null;
    let settings = null;
    let settingsError = null;
    try {
      settings = JSON.parse(
        fs.readFileSync(path.join(configHome ?? "", "muse", "settings.json"), "utf8")
      );
    } catch (e) {
      settingsError = String(e?.message ?? e);
    }
    let authExists = false;
    let authIsLink = false;
    try {
      const st = fs.lstatSync(path.join(configHome ?? "", "muse", "auth.json"));
      authExists = true;
      authIsLink = st.isSymbolicLink();
    } catch {
      // Absent (API-key auth) — recorded as-is.
    }
    fs.writeFileSync(
      process.env.FAKE_MSP_RECORD_CONFIG,
      `${JSON.stringify({
        configHome,
        dataHome: process.env.XDG_DATA_HOME ?? null,
        settings,
        settingsError,
        authExists,
        authIsLink,
      })}\n`
    );
  } catch {
    // Recording is test assistance only — never break the fake over it.
  }
}

if (mode === "slow-term-full") {
  // Linger after SIGTERM so the stale child's `close` lands after a restart.
  process.on("SIGTERM", () => {
    setTimeout(() => process.exit(0), 500);
  });
}

const CLIENT_NAME_RE = /^[a-z0-9_]+$/;

function record(msg) {
  if (!recordPath) return;
  try {
    fs.appendFileSync(
      recordPath,
      `${JSON.stringify({ method: msg.method ?? null, id: msg.id ?? null, params: msg.params ?? null })}\n`
    );
  } catch {
    // Recording is test assistance only — never break the fake over it.
  }
}

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function fullUsage() {
  return {
    observedAtMs: nowMs,
    tier: "contributor",
    window: { usedPercent: 60, resetsAtMs: nowMs + 2 * 3600_000, windowDurationMins: 300 },
    weekly: { usedPercent: 25, resetsAtMs: nowMs + 3 * 24 * 3600_000 },
  };
}

// Handshake state: the stable host requires `initialize` (with a valid
// clientInfo identity), then the `initialized` notification, before exactly
// one `usage/read`.
let initialized = false;
let notified = false;
let served = false;

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    record(msg);
    if (msg.id === undefined) {
      // Notification from client — only `initialized` advances the handshake.
      if (msg.method === "initialized" && initialized) notified = true;
      continue;
    }
    handleRequest(msg);
  }
});

function validClientInfo(params) {
  const info = params?.clientInfo;
  return (
    !!info &&
    typeof info === "object" &&
    typeof info.name === "string" &&
    CLIENT_NAME_RE.test(info.name) &&
    typeof info.version === "string" &&
    info.version.length > 0
  );
}

const EXEC_MODES = new Set([
  "serve-turn-full",
  "serve-turn-rejected",
  "serve-session-start-error",
  "serve-turn-failed",
  "serve-turn-hang",
]);

// Execution-mode state: sessions the fake has started, and whether provider
// traffic has been observed yet (usage/read is missing until the first turn
// completes — the NOT-269 fresh-host rule).
let sessionSeq = 0;
let turnSeq = 0;
const sessions = new Map();
let execObserved = false;

function handleRequest(msg) {
  switch (mode) {
    case "hang":
      return; // Never answer — exercises the client timeout.
    case "auth-error":
      send({ jsonrpc: "2.0", id: msg.id, error: { code: 401, message: "login is no longer valid" } });
      return;
    case "exit-nonzero":
      process.stderr.write("muse: login is no longer valid (unauthenticated)\n");
      process.exit(1);
      return;
    case "crash":
      process.stderr.write("boom: unexpected failure\n");
      process.exit(1);
      return;
    default:
      break;
  }
  if (msg.method === "initialize") {
    if (!validClientInfo(msg.params)) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "invalid clientInfo" } });
      return;
    }
    initialized = true;
    send({ jsonrpc: "2.0", id: msg.id, result: { serverInfo: { name: "fake-muse-serve" } } });
    return;
  }
  if (EXEC_MODES.has(mode)) {
    handleExecRequest(msg);
    return;
  }
  if (msg.method !== "usage/read") {
    // The adapter must never send a prompt or any other method.
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
    return;
  }
  if (!initialized) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "initialize required" } });
    return;
  }
  if (!notified) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "initialized notification required" } });
    return;
  }
  const persistent =
    mode === "persistent-full" || mode === "persistent-missing" || mode === "slow-term-full";
  if (served && !persistent) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "usage/read already served" } });
    return;
  }
  served = true;
  if (mode === "no-method") {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
    return;
  }
  if (mode === "malformed") {
    process.stdout.write("this is not msp\n");
    send({ jsonrpc: "2.0", id: msg.id, result: { nonsense: true } });
    return;
  }
  if (mode === "missing" || mode === "persistent-missing") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocol: "msp/1.3" } });
    return;
  }
  if (mode === "persistent-full" || mode === "slow-term-full") {
    send({
      jsonrpc: "2.0",
      method: "usage/changed",
      params: fullUsage(),
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { protocol: "msp/1.3", usage: fullUsage() } });
    return;
  }
  if (mode === "custom-duration") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocol: "msp/1.3",
        usage: {
          observedAtMs: nowMs,
          tier: "contributor",
          window: { usedPercent: 10, resetsAtMs: nowMs + 6 * 3600_000, windowDurationMins: 720 },
          weekly: { usedPercent: 50, resetsAtMs: nowMs + 5 * 24 * 3600_000 },
        },
      },
    });
    return;
  }
  if (mode === "partial-bad-weekly") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocol: "msp/1.3",
        usage: {
          observedAtMs: nowMs,
          tier: "contributor",
          window: { usedPercent: 20, resetsAtMs: nowMs + 3600_000, windowDurationMins: 300 },
          weekly: { usedPercent: "high", resetsAtMs: nowMs + 24 * 3600_000 },
        },
      },
    });
    return;
  }
  if (mode === "all-bad-windows") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocol: "msp/1.3",
        usage: {
          observedAtMs: nowMs,
          tier: "contributor",
          window: { usedPercent: "lots", resetsAtMs: "soon", windowDurationMins: "long" },
          weekly: { usedPercent: "high", resetsAtMs: "later" },
        },
      },
    });
    return;
  }
  send({
    jsonrpc: "2.0",
    method: "usage/changed",
    // NOT-269: stable schema refs SubscriptionUsage directly at
    // /notifications/usage/changed/params — not wrapped in {usage}.
    params: fullUsage(),
  });
  send({ jsonrpc: "2.0", id: msg.id, result: { protocol: "msp/1.3", usage: fullUsage() } });
  if (mode === "exit-after-first-read") {
    // Served exactly one full observation — now die so the owned host must
    // restart transparently (NOT-269 restart rule: state is lost).
    setTimeout(() => process.exit(0), 10);
  }
}

// --- NOT-270 serve execution lane -------------------------------------------

function requireExecHandshake(msg) {
  if (!initialized || !notified) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "initialize required" } });
    return false;
  }
  return true;
}

function execSession(params) {
  sessionSeq += 1;
  const sessionId = `sess-${sessionSeq}`;
  const session = {
    sessionId,
    modelId: params?.modelId ?? "test-model",
    approvalMode: params?.approvalMode ?? null,
    workspaceRoot: params?.workspaceRoot ?? null,
    status: "idle",
    activeTurnId: null,
  };
  sessions.set(sessionId, { session, prompt: null, turnId: null, completed: false });
  return session;
}

function emitTurnObserved(sessionId, turnId) {
  // Provider traffic on this host: usage/changed first, then the terminal.
  execObserved = true;
  send({ jsonrpc: "2.0", method: "usage/changed", params: fullUsage() });
  send({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: {
      sessionId,
      turnId,
      terminal: mode === "serve-turn-failed" ? "failed" : "completed",
      ...(mode === "serve-turn-failed"
        ? {
            error: {
              kind: "stepLimit",
              message: "did not reach a terminal state within 300 steps",
              retryable: false,
            },
          }
        : {}),
      usage: { inputTokens: 120, outputTokens: 45, cachedTokens: 0, reasoningTokens: 5 },
      durationMs: 1500,
      viewCursor: `vc-${turnId}`,
    },
  });
}

function handleExecRequest(msg) {
  if (msg.method === "usage/read") {
    if (!requireExecHandshake(msg)) return;
    // Fresh-host rule: missing until a turn on THIS host observed traffic.
    if (!execObserved) {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocol: "msp/1.3" } });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { protocol: "msp/1.3", usage: fullUsage() } });
    return;
  }
  if (msg.method === "session/start") {
    if (!requireExecHandshake(msg)) return;
    if (mode === "serve-session-start-error") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "session store unavailable" } });
      return;
    }
    const session = execSession(msg.params ?? {});
    send({ jsonrpc: "2.0", id: msg.id, result: { session, viewCursor: "vc-0" } });
    return;
  }
  if (msg.method === "turn/start") {
    if (!requireExecHandshake(msg)) return;
    const sessionId = msg.params?.sessionId;
    const entry = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (!entry) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "unknown session" } });
      return;
    }
    if (mode === "serve-turn-rejected") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "turn admission refused" } });
      return;
    }
    const input = msg.params?.input;
    if (!Array.isArray(input) || input.length === 0) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "input required" } });
      return;
    }
    turnSeq += 1;
    const turnId = `turn-${turnSeq}`;
    entry.turnId = turnId;
    entry.prompt = input.map((p) => p?.text ?? "").join("");
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        commandId: msg.params?.commandId ?? null,
        disposition: "started",
        startedNewTurn: true,
        status: "accepted",
        turnId,
      },
    });
    if (mode !== "serve-turn-hang") {
      // Delayed so the client's turn/completed subscription (registered
      // right after this ack) is in place before the terminal lands.
      setTimeout(() => emitTurnObserved(sessionId, turnId), 50);
    }
    return;
  }
  if (msg.method === "turn/cancel") {
    if (!requireExecHandshake(msg)) return;
    const sessionId = msg.params?.sessionId;
    const entry = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    send({ jsonrpc: "2.0", id: msg.id, result: { status: "accepted" } });
    if (entry && !entry.completed) {
      entry.completed = true;
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: {
            sessionId,
            turnId: msg.params?.turnId ?? entry.turnId ?? "turn-unknown",
            terminal: "cancelled",
            reason: "cancel requested",
            viewCursor: "vc-cancel",
          },
        });
      }, 20);
    }
    return;
  }
  if (msg.method === "session/read") {
    if (!requireExecHandshake(msg)) return;
    const sessionId = msg.params?.sessionId;
    const entry = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (!entry) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "unknown session" } });
      return;
    }
    const turnId = entry.turnId ?? "turn-unknown";
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        session: entry.session,
        history: {
          items: [
            { kind: "userMessage", text: entry.prompt ?? "", turnId },
            { kind: "agentMessage", text: "serve-lane reply text", turnId },
            { kind: "toolCall", tool: "read", callId: "call-1", status: "completed", turnId },
          ],
          mode: "inline",
          snapshot: null,
        },
        viewCursor: "vc-read",
      },
    });
    return;
  }
  // The execution lane allowlist is session/start, turn/start, turn/cancel,
  // session/read — anything else (session/resume, prompts, steering) is
  // refused exactly like the shipped host's unknown-method error.
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
}
