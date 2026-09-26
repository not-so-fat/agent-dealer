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
//     exit-nonzero | crash | no-method
//   FAKE_MSP_RECORD: path of a file to append one JSON line per received message
//   FAKE_MSP_NOW_MS: fixed clock for deterministic resetsAtMs (default Date.now())
//
// `full` mirrors the stable shape: observedAtMs, tier, a rolling `window`
// (300 min) and a weekly window. A `usage/changed` notification precedes the
// read response so tests can assert notification consumption.

import fs from "node:fs";

// The shipped `muse serve` takes no `--protocol` flag: reject it with the
// same usage error and exit code 2 production reports.
if (process.argv.includes("--protocol")) {
  process.stderr.write("muse serve: unknown option --protocol\nusage: muse serve [OPTIONS]\n");
  process.exit(2);
}

const mode = process.env.FAKE_MSP_MODE ?? "full";
const recordPath = process.env.FAKE_MSP_RECORD;
const nowMs = Number(process.env.FAKE_MSP_NOW_MS ?? Date.now());

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
  if (served) {
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
  if (mode === "missing") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocol: "msp/1.3" } });
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
}
