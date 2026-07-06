/**
 * Deep PoC: Cursor agent plan → execute, stream-json shapes, continuity model.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const LOG_DIR = path.join(ROOT, ".temporal/logs");

type StreamEvent = Record<string, unknown>;

function parseNdjson(raw: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t) as StreamEvent);
    } catch {
      // skip
    }
  }
  return events;
}

function summarizeEvents(events: StreamEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) {
    const t = String(e.type ?? "unknown");
    counts[t] = (counts[t] ?? 0) + 1;
  }
  return counts;
}

function extractResultText(events: StreamEvent[]): string | null {
  for (const e of events) {
    if (e.type === "result" && typeof e.result === "string") return e.result;
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const msg = events[i].message as { content?: Array<{ type?: string; text?: string }> } | undefined;
    if (msg?.content) {
      const text = msg.content.map((c) => c.text ?? "").join("");
      if (text.length > 30) return text;
    }
  }
  return null;
}

function extractToolUses(events: StreamEvent[]): Array<{ name: string }> {
  const tools: Array<{ name: string }> = [];
  for (const e of events) {
    const msg = e.message as { content?: Array<{ type?: string; name?: string }> } | undefined;
    if (!msg?.content) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.name) tools.push({ name: block.name });
    }
  }
  return tools;
}

async function runCursor(
  label: string,
  prompt: string,
  sessionId?: string
): Promise<{ exitCode: number; logPath: string; events: StreamEvent[]; sessionId: string | null }> {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `poc-cursor-${label}-${Date.now()}.ndjson`);
  const args = [
    "agent",
    "-p",
    "--trust",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
  ];
  if (sessionId) args.push("--resume", sessionId);
  args.push(prompt);

  return new Promise((resolve, reject) => {
    let raw = "";
    const logStream = fs.createWriteStream(logPath);
    const child = spawn("cursor", args, {
      cwd: ROOT,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (b: Buffer) => {
      const s = b.toString();
      raw += s;
      logStream.write(s);
    });
    child.stderr?.on("data", (b: Buffer) => logStream.write(b));
    child.on("error", reject);
    child.on("close", (code) => {
      logStream.end();
      const events = parseNdjson(raw);
      const init = events.find((e) => e.type === "system" && e.subtype === "init");
      const sid = typeof init?.session_id === "string" ? init.session_id : sessionId ?? null;
      resolve({ exitCode: code ?? 1, logPath, events, sessionId: sid });
    });
  });
}

async function main(): Promise<void> {
  const quick = process.argv.includes("--quick");

  if (quick) {
    console.log("=== Cursor agent: minimal reply (--quick) ===");
    const minimal = await runCursor("minimal", "Reply with exactly CURSOR_POC_OK and nothing else.");
    const types = summarizeEvents(minimal.events);
    const report = {
      ts: new Date().toISOString(),
      mode: "quick",
      minimal: {
        exitCode: minimal.exitCode,
        logPath: minimal.logPath,
        eventTypes: types,
        hasCursorPocOk: minimal.events.some((e) => e.type === "result" && e.result === "CURSOR_POC_OK"),
      },
    };
    const out = path.join(LOG_DIR, "poc-cursor-probe-report.json");
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(minimal.exitCode === 0 ? 0 : 1);
  }

  const report: Record<string, unknown> = {
    ts: new Date().toISOString(),
    phases: {} as Record<string, unknown>,
    conclusions: [] as string[],
  };

  console.log("=== Phase 1: plan (read-only tools expected) ===");
  const planPrompt = [
    "Draft a concise execution plan (markdown) for this task. Do NOT execute — plan only.",
    "",
    "## Task",
    "PoC: add a one-line comment to README.md saying integration PoC verified.",
    "",
    "Output step-by-step plan with risks. End with the plan markdown only.",
  ].join("\n");

  const planRun = await runCursor("plan", planPrompt);
  const planText = extractResultText(planRun.events);
  (report.phases as Record<string, unknown>).plan = {
    exitCode: planRun.exitCode,
    sessionId: planRun.sessionId,
    logPath: planRun.logPath,
    eventTypes: summarizeEvents(planRun.events),
    toolUses: extractToolUses(planRun.events),
    extractablePlanMarkdown: planText?.slice(0, 2000) ?? null,
  };
  console.log("plan exit:", planRun.exitCode, "session:", planRun.sessionId);
  console.log("plan extract:", planText?.slice(0, 200) ?? "(none)");

  console.log("\n=== Phase 2: execute (new process, plan in prompt) ===");
  const execPrompt = [
    "Execute this approved task.",
    "",
    "## Task",
    "PoC: Reply with exactly EXEC_POC_OK and nothing else. Do not edit files.",
    "",
    "## Approved plan",
    planText ?? "# Plan\n1. Reply EXEC_POC_OK\n2. Stop",
    "",
    "## Human feedback (simulated retry)",
    "Previous attempt was too verbose. Be minimal.",
  ].join("\n");

  const execRun = await runCursor("execute", execPrompt);
  const execResult = extractResultText(execRun.events);
  (report.phases as Record<string, unknown>).executeNewProcess = {
    exitCode: execRun.exitCode,
    sessionId: execRun.sessionId,
    logPath: execRun.logPath,
    eventTypes: summarizeEvents(execRun.events),
    extractableOutcome: execResult?.slice(0, 500) ?? null,
  };
  console.log("execute (new) exit:", execRun.exitCode, "result:", execResult?.slice(0, 80));

  // Phase 3: resume same session (if plan session exists)
  if (planRun.sessionId) {
    console.log("\n=== Phase 3: resume plan session with execute instruction ===");
    const resumePrompt =
      "Human approved the plan above. Now execute: reply with exactly RESUME_POC_OK only. Do not edit files.";
    const resumeRun = await runCursor("resume", resumePrompt, planRun.sessionId);
    const resumeResult = extractResultText(resumeRun.events);
    (report.phases as Record<string, unknown>).executeResume = {
      exitCode: resumeRun.exitCode,
      resumedSessionId: planRun.sessionId,
      logPath: resumeRun.logPath,
      eventTypes: summarizeEvents(resumeRun.events),
      extractableOutcome: resumeResult?.slice(0, 500) ?? null,
      sameSession: resumeRun.sessionId === planRun.sessionId,
    };
    console.log("resume exit:", resumeRun.exitCode, "result:", resumeResult?.slice(0, 80));
  }

  const conclusions = report.conclusions as string[];
  conclusions.push("Cursor CLI: cursor agent -p --trust --output-format stream-json (requires --trust in CI/non-interactive)");
  conclusions.push("Events: system(init), user, assistant (partial chunks with --stream-partial-output), result");
  conclusions.push("session_id on init — --resume <id> can continue plan→execute in ONE session (alternative to prompt carryover)");
  conclusions.push("v0 default: two processes + approved_plan in prompt; optional --resume for Cursor continuity");
  conclusions.push("Plan storable as draft_plan/approved_plan { markdown } + NDJSON blob_path");
  conclusions.push("Thought process: parse assistant + tool_use from NDJSON; partial streaming via multiple assistant events");

  const jsonPath = path.join(LOG_DIR, "poc-cursor-probe-report.json");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log("\nReport:", jsonPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
