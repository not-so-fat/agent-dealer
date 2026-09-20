#!/usr/bin/env node
// NOT-181: a fake `muse` for tests and CI — never calls the paid service. Point MUSE_CLI at this
// file. It speaks just enough of the pinned `muse exec --json` contract (NOT-177): one JSON envelope
// per stdout line, a session log with `model_completed` usage under $XDG_DATA_HOME, exit codes.
//
// FAKE_MUSE_SCENARIO picks the behaviour (default `success`); FAKE_MUSE_RECORD, when set, is a file
// the invocation (argv, cwd, XDG dirs, the settings.json it found) is written to.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];
const sessionId = flag("--session-id");
const model = flag("--model");
const scenario = process.env.FAKE_MUSE_SCENARIO ?? "success";
const RUN = "run-primary";

if (process.env.FAKE_MUSE_RECORD) {
  const cfg = process.env.XDG_CONFIG_HOME;
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
  fs.writeFileSync(
    process.env.FAKE_MUSE_RECORD,
    JSON.stringify({
      argv,
      cwd: process.cwd(),
      xdgConfigHome: cfg,
      xdgDataHome: process.env.XDG_DATA_HOME,
      noAutoUpdate: process.env.MUSE_NO_AUTO_UPDATE,
      settings: cfg ? read(path.join(cfg, "muse", "settings.json")) : null,
      authLinked: cfg ? fs.existsSync(path.join(cfg, "muse", "auth.json")) : false,
      porcelain: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }),
    })
  );
}

const envelope = (payloadType, payload) =>
  JSON.stringify({
    schema_version: 1,
    stream: { kind: "session", id: sessionId },
    payload_type: payloadType,
    payload: { run_stream: { kind: "run", id: RUN }, ...payload },
  });
const emit = (payloadType, payload) => process.stdout.write(`${envelope(payloadType, payload)}\n`);
const tool = (name, callId) => {
  emit("task.lifecycle.side_effect_intent", {
    event: { operation: `tool:${name}`, idempotency_key: `tool:${callId}`, task_id: `task-${callId}` },
  });
  emit("tool.result", { call_id: callId, correlation_facts: { outcome: "success", tool_name: name } });
};
const completed = (text) => emit("run.terminal.completed", { terminal: "completed", text, reason: null });
const failed = (reason) => emit("run.terminal.failed", { terminal: "failed", text: "", reason });

/** The session log is where Muse keeps usage and the server-confirmed model. */
function writeSessionLog({ usage, confirmedModel = model } = {}) {
  const dir = path.join(process.env.XDG_DATA_HOME, "muse", "sessions", "2026", "09", "20", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const event = { kind: "model_completed", duration_ms: 1500, ...(confirmedModel ? { model: confirmedModel } : {}) };
  if (usage) event.usage = usage;
  fs.writeFileSync(
    path.join(dir, "session.jsonl"),
    `${JSON.stringify({
      schema_version: 1,
      stream: { kind: "session", id: sessionId },
      payload_type: "runtime.session",
      payload: { kind: "run", run_id: RUN, event },
    })}\n`
  );
}

const USAGE = { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 50, cache_write_tokens: 0, reasoning_tokens: 10 };

function commitFeature() {
  fs.writeFileSync(path.join(process.cwd(), "feature.txt"), "implemented\n");
  // `add .` would stage the per-attempt config dir if the coordinator had not excluded it.
  execFileSync("git", ["add", "."]);
  execFileSync("git", ["-c", "user.email=muse@test", "-c", "user.name=Muse", "commit", "-q", "-m", "implement"]);
}

switch (scenario) {
  case "success":
  case "success-no-usage": {
    tool("bash", "call-1");
    commitFeature();
    writeSessionLog({ usage: scenario === "success" ? USAGE : undefined });
    completed("Implementation conclusion: added the widget.");
    break;
  }
  case "smoke": {
    // What scripts/muse-smoke.mts asks for, so the smoke script itself can be checked without Meta.
    tool("bash", "call-1");
    fs.writeFileSync(path.join(process.cwd(), "hello.txt"), "hello from muse\n");
    execFileSync("git", ["add", "."]);
    execFileSync("git", ["-c", "user.email=muse@test", "-c", "user.name=Muse", "commit", "-q", "-m", "hello"]);
    writeSessionLog({ usage: USAGE });
    completed("Created hello.txt.");
    break;
  }
  case "cron": {
    tool("cron_create", "call-1");
    commitFeature();
    writeSessionLog({ usage: USAGE });
    completed("Scheduled a job.");
    break;
  }
  case "cron-list": {
    tool("cron_list", "call-1");
    writeSessionLog({ usage: USAGE });
    completed("Listed jobs.");
    break;
  }
  case "wrong-model": {
    tool("bash", "call-1");
    commitFeature();
    writeSessionLog({ usage: USAGE, confirmedModel: "some-other-model" });
    completed("Implementation conclusion: added the widget.");
    break;
  }
  case "auth": {
    // Startup failure: stderr only, empty stdout (NOT-177 probe 10, cold catalog).
    process.stderr.write("missing meta credentials: run muse login or set META_API_KEY\n");
    process.exit(1);
    break;
  }
  case "usage-cap": {
    writeSessionLog({ usage: USAGE });
    failed("usage limit reached for this account");
    process.exit(1);
    break;
  }
  case "hang": {
    setInterval(() => {}, 1000);
    break;
  }
  default:
    process.stderr.write(`fake-muse: unknown scenario ${scenario}\n`);
    process.exit(2);
}
