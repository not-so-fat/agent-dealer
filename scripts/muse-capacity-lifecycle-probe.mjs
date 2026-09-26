#!/usr/bin/env node
// scripts/muse-capacity-lifecycle-probe.mjs
//
// NOT-269: rerunnable evidence probe for the Muse 5H/1W acquisition lifecycle.
// Sanitized by construction: prints key names, types, counts, and static
// failure strings only — never credential, tier, percent, timestamp, prompt,
// path, session-id, or model-output values.
//
// Legs (all read-only; nothing sends a prompt or consumes model tokens):
//   --schema                  offline: stable schema fingerprint + every
//                             SubscriptionUsage reference location.
//   --fresh-read              live one-shot `muse serve` handshake + usage/read,
//                             sanitized shape only. Skips honestly (exit 0,
//                             `live-skipped`) when the host cannot authenticate
//                             (e.g. sandboxed spawn without Keychain access).
//   --session-log <path>      key-shape-only scan of one session/exec JSONL
//                             log: record counts by payload_type + whether any
//                             subscription-usage key appears anywhere.
//   --echo                    free `--provider echo` exec control: event count
//                             + usage-key search (no auth, no billing, local).
//   --live-turn               BILLABLE: spends one real minimal turn in a
//                             disposable scratch session on a real serve
//                             host, then observes (a) same-host usage/changed
//                             + usage/read, (b) restart persistence on a
//                             fresh host, (c) session/resume without a new
//                             prompt on another fresh host (non-billable).
//                             Never touches an existing project session.
//                             Requires MUSE_PROBE_CONFIRM_REAL_TURN=1 or it
//                             reports confirmation-required and does nothing.
//
// Default (no flags): --schema only. Live legs are opt-in. Examples:
//   node scripts/muse-capacity-lifecycle-probe.mjs --schema
//   node scripts/muse-capacity-lifecycle-probe.mjs --schema --fresh-read
//   node scripts/muse-capacity-lifecycle-probe.mjs --session-log <file.jsonl>
//   MUSE_PROBE_CONFIRM_REAL_TURN=1 node scripts/muse-capacity-lifecycle-probe.mjs --live-turn

import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const want = (f) => args.includes(f);
const valueOf = (f) => {
  const i = args.indexOf(f);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};

const BIN = process.env.MUSE_CLI ?? path.join(os.homedir(), ".local/bin/muse");
const TIMEOUT_MS = 20_000;
const out = (obj) => console.log(JSON.stringify(obj));

function museVersion() {
  try {
    return execFileSync(BIN, ["--version"], {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" },
    }).trim();
  } catch {
    return null;
  }
}

// --- offline schema leg -----------------------------------------------------
function schemaLeg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-schema-"));
  try {
    execFileSync(BIN, ["schema", "generate-json-schema", "--out", dir], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" },
    });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { leg: "schema", outcome: "schema-export-failed" };
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const schema = JSON.parse(fs.readFileSync(path.join(dir, "msp.schema.json"), "utf8"));
  fs.rmSync(dir, { recursive: true, force: true });
  const hits = [];
  const walk = (o, trail) => {
    if (Array.isArray(o)) return o.forEach((v, i) => walk(v, `${trail}[${i}]`));
    if (o && typeof o === "object") {
      for (const [k, v] of Object.entries(o)) {
        if (k === "$ref" && typeof v === "string" && v.includes("SubscriptionUsage")) {
          hits.push({ at: trail, ref: v });
        } else walk(v, `${trail}/${k}`);
      }
    }
  };
  walk(schema, "");
  const resumeKeys =
    schema.$defs?.SessionResumeResult?.properties
      ? Object.keys(schema.$defs.SessionResumeResult.properties).sort()
      : null;
  const usageRequired = schema.$defs?.SubscriptionUsage?.required ?? null;
  return {
    leg: "schema",
    outcome: "ok",
    manifestFingerprint: manifest.fingerprint ?? null,
    manifestExperimental: manifest.experimental ?? null,
    subscriptionUsageRefLocations: hits
      .filter((h) => h.ref === "#/$defs/SubscriptionUsage")
      .map((h) => h.at)
      .sort(),
    subscriptionUsageRequiredKeys: usageRequired,
    sessionResumeResultKeys: resumeKeys,
    usageReadDescription: schema.methods?.["usage/read"]?.description ?? null,
  };
}

// --- live fresh-read leg (sanitized) ----------------------------------------
function sanitizeUsage(usage) {
  if (usage === undefined) return { present: false };
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return { present: true, malformed: true };
  }
  const entry = (e) =>
    e === undefined
      ? { present: false }
      : !e || typeof e !== "object"
        ? { present: true, malformed: true }
        : {
            present: true,
            hasUsedPercent: typeof e.usedPercent === "number",
            hasResetsAtMs: typeof e.resetsAtMs === "number",
            hasWindowDurationMins: typeof e.windowDurationMins === "number",
          };
  return {
    present: true,
    topKeys: Object.keys(usage).sort(),
    hasObservedAtMs: typeof usage.observedAtMs === "number",
    hasTier: typeof usage.tier === "string",
    window: entry(usage.window),
    weekly: entry(usage.weekly),
  };
}

function freshReadLeg() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(BIN, ["serve"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" },
      });
    } catch (e) {
      resolve({ leg: "fresh-read", outcome: "live-skipped", reason: "spawn-failed" });
      return;
    }
    let buf = "";
    let settled = false;
    let stderrTail = "";
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => done({ leg: "fresh-read", outcome: "timeout" }), TIMEOUT_MS);
    timer.unref?.();
    child.stderr?.on("data", (c) => {
      stderrTail = `${stderrTail}${c.toString()}`.slice(-300);
    });
    child.stdout?.on("data", (c) => {
      buf += c.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.method && msg.id === undefined) continue; // notifications dropped, never printed
        if (msg.id === "probe-init") {
          if (msg.error) {
            done({ leg: "fresh-read", outcome: "live-skipped", reason: "init-error" });
            return;
          }
          try {
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "probe-read", method: "usage/read", params: {} })}\n`);
          } catch { done({ leg: "fresh-read", outcome: "live-skipped", reason: "write-failed" }); }
        } else if (msg.id === "probe-read") {
          if (msg.error) {
            done({ leg: "fresh-read", outcome: "read-error", errorStatic: "provider-error" });
            return;
          }
          const result = msg.result && typeof msg.result === "object" ? msg.result : {};
          done({
            leg: "fresh-read",
            outcome: "read-ok",
            resultKeys: Object.keys(result).sort(),
            usage: sanitizeUsage(result.usage),
          });
        }
      }
    });
    child.on("error", () => done({ leg: "fresh-read", outcome: "live-skipped", reason: "spawn-error" }));
    child.on("close", (code) => {
      if (settled) return;
      // Static classification only: never print stderr (may name local paths).
      const reason = /keychain|OSStatus/i.test(stderrTail)
        ? "keychain-unreadable"
        : /auth file|Operation not permitted|login|credential/i.test(stderrTail)
          ? "auth-unreadable"
          : `early-close-${code}`;
      done({ leg: "fresh-read", outcome: "live-skipped", reason });
    });
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "probe-init", method: "initialize", params: { clientInfo: { name: "probe", version: "0.0.1" } } })}\n`);
    } catch { done({ leg: "fresh-read", outcome: "live-skipped", reason: "write-failed" }); }
  });
}

// --- session-log scan leg (key names + counts only) --------------------------
const USAGE_KEYS = new Set([
  "usedpercent", "resetsatms", "observedatms", "windowdurationmins",
  "subscriptionusage", "subscription", "window", "weekly",
]);

function sessionLogLeg(file) {
  const payloadTypes = new Map();
  const usageHits = new Map();
  let total = 0;
  const walk = (o, depth) => {
    const found = new Set();
    if (o && typeof o === "object") {
      const entries = Array.isArray(o) ? o.slice(0, 50).entries() : Object.entries(o);
      for (const [k, v] of entries) {
        if (typeof k === "string" && USAGE_KEYS.has(k.toLowerCase())) found.add(k);
        if (depth < 12) for (const f of walk(v, depth + 1)) found.add(f);
      }
    }
    return found;
  };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    total += 1;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const pt = rec && typeof rec === "object" ? String(rec.payload_type ?? rec.type ?? "?") : "?";
    payloadTypes.set(pt, (payloadTypes.get(pt) ?? 0) + 1);
    for (const k of walk(rec, 0)) usageHits.set(k, (usageHits.get(k) ?? 0) + 1);
  }
  return {
    leg: "session-log-scan",
    outcome: "ok",
    records: total,
    payloadTypeCounts: Object.fromEntries([...payloadTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)),
    subscriptionUsageKeyHits: Object.fromEntries(usageHits),
  };
}

// --- free echo control leg ----------------------------------------------------
function echoLeg() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "muse-echo-ws-"));
  const argv = ["exec", "--provider", "echo", "--json", "--no-session-log", "--workspace", ws, "probe ping"];
  // The echo provider needs no credentials; drop a redirected XDG_CONFIG_HOME
  // so settings lookup uses the real HOME (spawn sandboxes may redirect it to
  // an unreadable dir, which fails settings load before the run starts).
  const env = { ...process.env, MUSE_NO_AUTO_UPDATE: "1" };
  delete env.XDG_CONFIG_HOME;
  let raw = "";
  try {
    raw = execFileSync(BIN, argv, { encoding: "utf8", timeout: 60_000, env });
  } catch (e) {
    // A nonzero exit can still stream partial frames; scan whatever arrived.
    raw = typeof e?.stdout === "string" ? e.stdout : "";
    if (!raw) {
      fs.rmSync(ws, { recursive: true, force: true });
      return { leg: "echo-exec", outcome: "echo-failed" };
    }
  }
  fs.rmSync(ws, { recursive: true, force: true });
  let records = 0;
  let hits = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    records += 1;
    const low = line.toLowerCase();
    if (low.includes("usedpercent") || low.includes("resetsatms") || low.includes("observedatms") || low.includes("subscriptionusage")) {
      hits += 1;
    }
  }
  return { leg: "echo-exec", outcome: "ok", records, recordsWithSubscriptionUsageKeys: hits };
}

// --- live turn / restart / resume legs (real, billable) ---------------------
// NOT-269 escalation follow-up: the three lifecycle legs that could not run
// in the sandbox (no Keychain). Spends exactly one real minimal turn in a
// disposable scratch session — never touches an existing project session.
// Gated behind --live-turn AND MUSE_PROBE_CONFIRM_REAL_TURN=1 so it can never
// fire by accident from a plain rerun of this harness.

function uuidv7() {
  const now = BigInt(Date.now());
  const r = randomBytes(10);
  const b = new Uint8Array(16);
  for (let i = 0; i < 6; i++) b[i] = Number((now >> BigInt(40 - 8 * i)) & 0xffn);
  b[6] = 0x70 | (r[0] & 0x0f);
  b[7] = r[1];
  b[8] = 0x80 | (r[2] & 0x3f);
  b[9] = r[3];
  b.set(r.subarray(4, 10), 10);
  const hex = Buffer.from(b).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** One JSON-RPC-over-stdio `muse serve` host: write(obj), on(matcher, cb), close(). */
function museHost() {
  const child = spawn(BIN, ["serve"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" },
  });
  const waiters = [];
  let buf = "";
  let stderrTail = "";
  child.stderr?.on("data", (c) => { stderrTail = `${stderrTail}${c}`.slice(-300); });
  child.stdout?.on("data", (c) => {
    buf += c.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].match(msg)) {
          const w = waiters.splice(i, 1)[0];
          w.resolve(msg);
        }
      }
    }
  });
  const closed = new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, stderrTail }));
    child.on("error", () => resolve({ code: null, stderrTail }));
  });
  return {
    write(obj) { child.stdin.write(`${JSON.stringify(obj)}\n`); },
    wait(match, timeoutMs = 30_000) {
      return new Promise((resolve) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) { waiters.splice(i, 1); resolve(null); }
        }, timeoutMs).unref?.();
      });
    },
    async kill() {
      try { child.kill(); } catch {}
      return closed;
    },
  };
}

async function initHost(host) {
  host.write({ jsonrpc: "2.0", id: "init", method: "initialize", params: { clientInfo: { name: "not269_probe", version: "0.0.1" } } });
  const initReply = await host.wait((m) => m.id === "init");
  if (!initReply || initReply.error) return { ok: false, reason: initReply?.error ? "init-error" : "init-timeout" };
  host.write({ jsonrpc: "2.0", method: "initialized", params: {} });
  return { ok: true };
}

async function usageReadOn(host) {
  host.write({ jsonrpc: "2.0", id: "read", method: "usage/read", params: {} });
  const reply = await host.wait((m) => m.id === "read", 15_000);
  if (!reply || reply.error) return { outcome: "read-error" };
  const result = reply.result && typeof reply.result === "object" ? reply.result : {};
  return { outcome: "read-ok", resultKeys: Object.keys(result).sort(), usage: sanitizeUsage(result.usage) };
}

async function freshHostRead(label) {
  const host = museHost();
  const init = await initHost(host);
  if (!init.ok) {
    const { code, stderrTail } = await host.kill();
    const reason = /keychain|OSStatus/i.test(stderrTail)
      ? "keychain-unreadable"
      : /auth file|Operation not permitted|login|credential/i.test(stderrTail)
        ? "auth-unreadable"
        : `${init.reason}-${code}`;
    return { leg: label, outcome: "live-skipped", reason };
  }
  const read = await usageReadOn(host);
  await host.kill();
  return { leg: label, ...read };
}

async function liveTurnLeg() {
  if (process.env.MUSE_PROBE_CONFIRM_REAL_TURN !== "1") {
    return {
      leg: "live-turn",
      outcome: "confirmation-required",
      reason: "set MUSE_PROBE_CONFIRM_REAL_TURN=1 to spend one real minimal turn",
    };
  }
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "muse-live-turn-ws-"));
  const results = [];
  let sessionId = null;
  try {
    // Leg A: same host, real session/turn, then usage/changed + usage/read.
    const hostA = museHost();
    const initA = await initHost(hostA);
    if (!initA.ok) {
      results.push({ leg: "same-host-post-turn", outcome: "live-skipped", reason: initA.reason });
    } else {
      const usageChangedPromise = hostA.wait((m) => m.method === "usage/changed", 120_000);
      const startCmd = uuidv7();
      hostA.write({
        jsonrpc: "2.0", id: "start", method: "session/start",
        params: { commandId: startCmd, workspaceRoot: ws },
      });
      const startReply = await hostA.wait((m) => m.id === "start", 30_000);
      if (!startReply || startReply.error) {
        results.push({ leg: "same-host-post-turn", outcome: "session-start-failed" });
      } else {
        sessionId = startReply.result?.session?.sessionId ?? null;
        const turnCmd = uuidv7();
        hostA.write({
          jsonrpc: "2.0", id: "turn", method: "turn/start",
          params: {
            commandId: turnCmd,
            sessionId,
            input: [{ type: "text", text: "Reply with only the single word OK." }],
          },
        });
        const turnAck = await hostA.wait((m) => m.id === "turn", 30_000);
        const completed = await hostA.wait(
          (m) => m.method === "turn/completed" && m.params?.sessionId === sessionId,
          180_000
        );
        const usageChanged = await usageChangedPromise;
        const read = await usageReadOn(hostA);
        results.push({
          leg: "same-host-post-turn",
          outcome: "ok",
          turnAdmitted: !!(turnAck && !turnAck.error),
          turnTerminal: completed?.params?.terminal ?? "no-completion-observed",
          usageChangedObserved: !!usageChanged,
          ...read,
        });
      }
    }
    await hostA.kill();

    // Leg B: restart persistence — brand-new host, immediate read, no session touch.
    results.push(await freshHostRead("restart-persistence"));

    // Leg C: resume the same session without a new prompt (non-billable).
    if (sessionId) {
      const hostC = museHost();
      const initC = await initHost(hostC);
      if (!initC.ok) {
        results.push({ leg: "resume-no-prompt", outcome: "live-skipped", reason: initC.reason });
      } else {
        hostC.write({
          jsonrpc: "2.0", id: "resume", method: "session/resume",
          params: { commandId: uuidv7(), sessionId },
        });
        const resumeReply = await hostC.wait((m) => m.id === "resume", 30_000);
        const read = await usageReadOn(hostC);
        results.push({
          leg: "resume-no-prompt",
          outcome: "ok",
          resumeOk: !!(resumeReply && !resumeReply.error),
          ...read,
        });
      }
      await hostC.kill();
    } else {
      results.push({ leg: "resume-no-prompt", outcome: "skipped-no-session" });
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  return { leg: "live-turn", outcome: "ok", legs: results };
}

// --- main --------------------------------------------------------------------
const version = museVersion();
console.error(`muse: ${version ?? "binary unavailable"}`);
const anyLiveFlag = () =>
  want("--fresh-read") || !!valueOf("--session-log") || want("--echo") || want("--live-turn");
if (!anyLiveFlag()) {
  out({ version, ...schemaLeg() });
} else {
  if (want("--schema")) {
    out({ version, ...schemaLeg() });
  }
  if (want("--fresh-read")) out({ version, ...(await freshReadLeg()) });
  const logPath = valueOf("--session-log");
  if (logPath) {
    if (!fs.existsSync(logPath)) out({ leg: "session-log-scan", outcome: "file-not-found" });
    else out({ version, ...sessionLogLeg(logPath) });
  }
  if (want("--echo")) out({ version, ...echoLeg() });
  if (want("--live-turn")) out({ version, ...(await liveTurnLeg()) });
}
