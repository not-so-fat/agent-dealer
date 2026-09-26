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
//
// Default (no flags): --schema only. Live legs are opt-in. Examples:
//   node scripts/muse-capacity-lifecycle-probe.mjs --schema
//   node scripts/muse-capacity-lifecycle-probe.mjs --schema --fresh-read
//   node scripts/muse-capacity-lifecycle-probe.mjs --session-log <file.jsonl>

import { spawn, execFileSync } from "node:child_process";
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
    return { leg: "schema", outcome: "schema-export-failed" };
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const schema = JSON.parse(fs.readFileSync(path.join(dir, "msp.schema.json"), "utf8"));
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
        if (msg.method && msg.id === undefined) continue; // notifications recorded, values never printed
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
  "subscriptionusage", "subscription",
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
    if (!raw) return { leg: "echo-exec", outcome: "echo-failed" };
  }
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

// --- main --------------------------------------------------------------------
const version = museVersion();
console.error(`muse: ${version ?? "binary unavailable"}`);
if (!want("--fresh-read") && !valueOf("--session-log") && !want("--echo")) {
  out({ version, ...schemaLeg() });
} else {
  if (want("--schema") || (!want("--fresh-read") && !valueOf("--session-log") && !want("--echo"))) {
    out({ version, ...schemaLeg() });
  }
  if (want("--fresh-read")) out({ version, ...(await freshReadLeg()) });
  const logPath = valueOf("--session-log");
  if (logPath) {
    if (!fs.existsSync(logPath)) out({ leg: "session-log-scan", outcome: "file-not-found" });
    else out({ version, ...sessionLogLeg(logPath) });
  }
  if (want("--echo")) out({ version, ...echoLeg() });
}
