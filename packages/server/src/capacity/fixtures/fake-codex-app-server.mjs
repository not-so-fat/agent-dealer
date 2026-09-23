// packages/server/src/capacity/fixtures/fake-codex-app-server.mjs
//
// NOT-246: fake Codex App Server for tests. Speaks the JSONL protocol over
// stdio: answers `initialize`, then `account/rateLimits/read` (or a failure
// mode), so adapter tests never touch a live provider.
//
// Env:
//   FAKE_CODEX_MODE: ok | mirror | auth-error | malformed | hang | exit-nonzero | crash | no-method
//   FAKE_CODEX_RECORD: path of a file to append one JSON line per received message
//   FAKE_CODEX_NOW_MS: fixed clock for deterministic resetsAt (default Date.now())
//
// `ok` payload mirrors the documented shapes: epoch-second resetsAt, a 300-min
// primary and a 10,080-min secondary window, plus two `rateLimitsByLimitId`
// buckets in the official nested snapshot shape
// ({ limitId, limitName, primary, secondary }). An
// `account/rateLimits/updated` notification precedes the read response so
// tests can assert notification consumption.
//
// `mirror` (NOT-263) is the production duplicate shape: the aggregate
// `rateLimits` primary/secondary pair carries exactly the same values as one
// `rateLimitsByLimitId` bucket (`main`), while a second bucket (`extra`)
// stays genuinely distinct — so tests prove the aggregate aliases collapse
// to the detailed identity without hiding distinct buckets.

import fs from "node:fs";

const mode = process.env.FAKE_CODEX_MODE ?? "ok";
const recordPath = process.env.FAKE_CODEX_RECORD;
const nowMs = Number(process.env.FAKE_CODEX_NOW_MS ?? Date.now());
const epochSec = (deltaMs) => Math.floor((nowMs + deltaMs) / 1000);

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

function mirrorPayload() {
  const mainPrimary = {
    usedPercent: 70,
    windowDurationMins: 300,
    resetsAt: epochSec(1 * 3600_000),
  };
  const mainSecondary = {
    usedPercent: 5,
    windowDurationMins: 10080,
    resetsAt: epochSec(6 * 24 * 3600_000),
  };
  return {
    // Aggregate pair is value-identical to the `main` bucket below.
    rateLimits: {
      primary: { ...mainPrimary },
      secondary: { ...mainSecondary },
    },
    rateLimitsByLimitId: {
      main: {
        limitId: "main",
        limitName: "Main quota",
        primary: { ...mainPrimary },
        secondary: { ...mainSecondary },
      },
      extra: {
        limitId: "extra",
        limitName: "Extra quota",
        primary: {
          usedPercent: 90,
          windowDurationMins: 300,
          resetsAt: epochSec(30 * 60_000),
        },
        secondary: {
          usedPercent: 25,
          windowDurationMins: 10080,
          resetsAt: epochSec(2 * 24 * 3600_000),
        },
      },
    },
  };
}

function okPayload() {
  return {
    rateLimits: {
      primary: {
        usedPercent: 40,
        windowDurationMins: 300,
        resetsAt: epochSec(2 * 3600_000),
      },
      secondary: {
        usedPercent: 12.5,
        windowDurationMins: 10080,
        resetsAt: epochSec(3 * 24 * 3600_000),
      },
    },
    rateLimitsByLimitId: {
      main: {
        limitId: "main",
        limitName: "Main quota",
        primary: {
          usedPercent: 70,
          windowDurationMins: 300,
          resetsAt: epochSec(1 * 3600_000),
        },
        secondary: {
          usedPercent: 5,
          windowDurationMins: 10080,
          resetsAt: epochSec(6 * 24 * 3600_000),
        },
      },
      extra: {
        limitId: "extra",
        limitName: "Extra quota",
        primary: {
          usedPercent: 90,
          windowDurationMins: 300,
          resetsAt: epochSec(30 * 60_000),
        },
        secondary: {
          usedPercent: 25,
          windowDurationMins: 10080,
          resetsAt: epochSec(2 * 24 * 3600_000),
        },
      },
    },
  };
}

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
    if (msg.id === undefined) continue; // Notification from client — ignore.
    handleRequest(msg);
  }
});

function handleRequest(msg) {
  switch (mode) {
    case "hang":
      return; // Never answer — exercises the client timeout.
    case "auth-error":
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32001, message: "unauthenticated: sign in to Codex" } });
      return;
    case "exit-nonzero":
      process.stderr.write("codex: not signed in (unauthenticated)\n");
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
    send({ jsonrpc: "2.0", id: msg.id, result: { serverInfo: { name: "fake-codex-app-server" } } });
    return;
  }
  if (msg.method === "account/rateLimits/read") {
    if (mode === "no-method") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      return;
    }
    if (mode === "malformed") {
      process.stdout.write("this is not jsonl\n");
      send({ jsonrpc: "2.0", id: msg.id, result: { nonsense: true } });
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "account/rateLimits/updated",
      params: { rateLimits: { primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: epochSec(2 * 3600_000) } } },
    });
    send({ jsonrpc: "2.0", id: msg.id, result: mode === "mirror" ? mirrorPayload() : okPayload() });
    return;
  }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
}
