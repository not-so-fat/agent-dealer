/**
 * Deep PoC: Claude plan → execute continuity, stream-json event shapes, storable artifacts.
 * Output: .temporal/logs/poc-claude-probe-report.json + human-readable .md
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const LOG_DIR = path.join(ROOT, ".temporal/logs");
const mcpConfig = process.env.CLAUDE_MCP_CONFIG ?? path.join(process.env.HOME ?? "", ".claude.json");

function loadEnv(): void {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

loadEnv();

type StreamEvent = Record<string, unknown>;

function parseNdjson(raw: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t) as StreamEvent);
    } catch {
      // non-json
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
    const e = events[i];
    const msg = e.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
    if (msg?.content) {
      const text = msg.content.map((c) => c.text ?? "").join("");
      if (text.length > 30) return text;
    }
  }
  return null;
}

function extractToolUses(events: StreamEvent[]): Array<{ name: string; input?: unknown }> {
  const tools: Array<{ name: string; input?: unknown }> = [];
  for (const e of events) {
    const msg = e.message as { content?: Array<{ type?: string; name?: string; input?: unknown }> } | undefined;
    if (!msg?.content) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.name) {
        tools.push({ name: block.name, input: block.input });
      }
    }
  }
  return tools;
}

async function runClaude(
  label: string,
  prompt: string,
  extraArgs: string[] = []
): Promise<{ exitCode: number; raw: string; logPath: string; events: StreamEvent[] }> {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `poc-claude-${label}-${Date.now()}.ndjson`);
  const args = [
    "-p",
    prompt,
    "--mcp-config",
    mcpConfig,
    "--max-turns",
    "3",
    "--max-budget-usd",
    "0.25",
    "--output-format",
    "stream-json",
    "--verbose",
    ...extraArgs,
  ];

  return new Promise((resolve, reject) => {
    let raw = "";
    const logStream = fs.createWriteStream(logPath);
    const child = spawn("claude", args, {
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
      resolve({ exitCode: code ?? 1, raw, logPath, events: parseNdjson(raw) });
    });
  });
}

async function main(): Promise<void> {
  if (!fs.existsSync(mcpConfig)) {
    console.error("SKIP: MCP config missing at", mcpConfig);
    process.exit(1);
  }

  // Auth preflight (avoid silent "Not logged in" in stream-json)
  const authCheck = await runClaude("auth-check", "Reply OK", ["--max-turns", "1", "--max-budget-usd", "0.01"]);
  const authFailed = authCheck.events.some(
    (e) => e.error === "authentication_failed" || String(e.result ?? "").includes("Not logged in")
  );
  if (authFailed) {
    console.error("BLOCKER: Claude not authenticated. Run `claude login` or set ANTHROPIC_API_KEY in .env");
    process.exit(2);
  }

  const report: Record<string, unknown> = {
    ts: new Date().toISOString(),
    mcpConfig,
    phases: {} as Record<string, unknown>,
    conclusions: [] as string[],
  };

  // Phase 1: Plan-only (what we can store as draft_plan)
  console.log("=== Phase 1: plan mode ===");
  const planPrompt = [
    "Draft a concise execution plan (markdown) for this task. Do NOT execute — plan only.",
    "",
    "## Task",
    "PoC: add a one-line comment to README.md saying integration PoC verified.",
    "",
    "Output step-by-step plan with risks. End with the plan markdown only.",
  ].join("\n");

  const planRun = await runClaude("plan", planPrompt, [
    "--allowedTools",
    "Read,Glob,Grep",
  ]);
  const planText = extractResultText(planRun.events);
  (report.phases as Record<string, unknown>).plan = {
    exitCode: planRun.exitCode,
    logPath: planRun.logPath,
    eventTypes: summarizeEvents(planRun.events),
    toolUses: extractToolUses(planRun.events),
    extractablePlanMarkdown: planText?.slice(0, 2000) ?? null,
    storableAs: ["draft_plan.contentJson.markdown", "blob_path → ndjson log"],
  };
  console.log("plan exit:", planRun.exitCode, "events:", summarizeEvents(planRun.events));
  console.log("plan extract:", planText?.slice(0, 200) ?? "(none)");

  if (!planText) {
    (report.conclusions as string[]).push("BLOCKER: cannot extract plan markdown from stream-json");
  }

  // Phase 2: Execute with embedded approved plan (continuity model v0: new process, same context in prompt)
  console.log("\n=== Phase 2: execute with approved plan in prompt ===");
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

  const execRun = await runClaude("execute", execPrompt);
  const execResult = extractResultText(execRun.events);
  (report.phases as Record<string, unknown>).execute = {
    exitCode: execRun.exitCode,
    logPath: execRun.logPath,
    eventTypes: summarizeEvents(execRun.events),
    toolUses: extractToolUses(execRun.events),
    extractableOutcome: execResult?.slice(0, 2000) ?? null,
    storableAs: [
      "transcript.contentJson.excerpt",
      "transcript.blob_path",
      "feedback.contentJson on retry",
      "deliverable/pr/diff artifacts (future)",
    ],
  };
  console.log("execute exit:", execRun.exitCode, "result:", execResult?.slice(0, 120));

  // Phase 3: What stream-json gives us for "thought process"
  const sampleTypes = new Set<string>();
  for (const e of [...planRun.events, ...execRun.events]) {
    sampleTypes.add(String(e.type ?? "unknown"));
  }
  (report.phases as Record<string, unknown>).streamJson = {
    observedTypes: [...sampleTypes],
    thoughtProcess:
      "Assistant messages + tool_use blocks in stream-json; full NDJSON on disk. No single 'reasoning' field — parse message/tool events.",
    costFields: execRun.events.find((e) => e.type === "result") ?? null,
  };

  // Conclusions
  const conclusions = report.conclusions as string[];
  conclusions.push(
    "v0 continuity = two claude -p processes; shared context via approved_plan + task_snapshot in prompt (not --resume session)"
  );
  conclusions.push(
    "Plan data: markdown in artifact JSON + full NDJSON log at blob_path"
  );
  conclusions.push(
    "Feedback: human retry → new run with lineage_id + feedback artifact; inject into execution prompt (not implemented in runner yet)"
  );
  conclusions.push(
    "Thought process: replay NDJSON (tool_use, assistant messages); UI transcript viewer reads blob tail"
  );

  if (planRun.exitCode !== 0 && !planText) conclusions.push("Plan phase failed — check claude auth/budget");
  if (execRun.exitCode !== 0 && !execResult) conclusions.push("Execute phase failed — check claude auth/budget");

  const jsonPath = path.join(LOG_DIR, "poc-claude-probe-report.json");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const md = [
    "# Claude runner PoC report",
    "",
    `Generated: ${report.ts}`,
    "",
    "## Plan phase",
    `- exit: ${planRun.exitCode}`,
    `- events: ${JSON.stringify(summarizeEvents(planRun.events))}`,
    `- log: ${planRun.logPath}`,
    "",
    "## Execute phase",
    `- exit: ${execRun.exitCode}`,
    `- events: ${JSON.stringify(summarizeEvents(execRun.events))}`,
    `- log: ${execRun.logPath}`,
    "",
    "## Conclusions",
    ...conclusions.map((c) => `- ${c}`),
  ].join("\n");
  fs.writeFileSync(path.join(LOG_DIR, "poc-claude-probe-report.md"), md);

  console.log("\nReport:", jsonPath);
  console.log(md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
