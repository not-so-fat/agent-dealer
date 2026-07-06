#!/usr/bin/env tsx
/**
 * P0 proof script: read Linear issue IDs from a file, run claude -p with agent-deck MCP.
 * Usage: npm run p0 -- scripts/fixtures/issue-ids.example.txt
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const idsFile = process.argv[2] ?? "scripts/fixtures/issue-ids.example.txt";
const mcpConfig = process.env.CLAUDE_MCP_CONFIG ?? path.join(process.env.HOME ?? "", ".claude.json");
const deckId = process.env.DECK_ID;
const playbookId = process.env.PLAYBOOK_ID;
const workspaceRoot = process.env.WORKSPACE_ROOT ?? process.cwd();
const maxTurns = process.env.MAX_TURNS ?? "30";
const maxBudget = process.env.MAX_BUDGET_USD ?? "5.00";

function which(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    spawn("which", [cmd]).on("close", (code) => resolve(code === 0));
  });
}

function runClaude(issueId: string): Promise<number> {
  const logDir = path.join(process.cwd(), ".temporal", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${issueId}-${Date.now()}.ndjson`);

  const promptParts = [
    `Work Linear issue ${issueId}.`,
    deckId ? `bind_workspace({ deckId: "${deckId}", workspaceRoot: "${workspaceRoot}" })` : "",
    playbookId ? `Use playbook ${playbookId}.` : "",
    "Implement the issue. Summarize what you did when finished.",
  ].filter(Boolean);

  const args = [
    "-p",
    promptParts.join(" "),
    "--mcp-config",
    mcpConfig,
    "--max-turns",
    maxTurns,
    "--max-budget-usd",
    maxBudget,
    "--output-format",
    "stream-json",
  ];

  console.log(`\n=== ${issueId} → ${logPath} ===`);

  return new Promise((resolve, reject) => {
    const logStream = fs.createWriteStream(logPath);
    const child = spawn("claude", args, {
      cwd: workspaceRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);
    child.on("error", reject);
    child.on("close", (code) => {
      logStream.end();
      console.log(`=== ${issueId} exit ${code} ===`);
      resolve(code ?? 1);
    });
  });
}

async function main(): Promise<void> {
  if (!(await which("claude"))) {
    console.error("claude CLI not found on PATH");
    process.exit(1);
  }
  if (!fs.existsSync(mcpConfig)) {
    console.error(`MCP config not found: ${mcpConfig}`);
    process.exit(1);
  }
  if (!fs.existsSync(idsFile)) {
    console.error(`Issue IDs file not found: ${idsFile}`);
    console.error("Create scripts/fixtures/issue-ids.example.txt with one ID per line (e.g. LIN-123)");
    process.exit(1);
  }

  const ids = fs
    .readFileSync(idsFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  if (ids.length === 0) {
    console.error("No issue IDs in file");
    process.exit(1);
  }

  console.log(`Running ${ids.length} issue(s) from ${idsFile}`);

  for (const id of ids) {
    const code = await runClaude(id);
    if (code !== 0) {
      console.error(`Stopped on first failure: ${id}`);
      process.exit(code);
    }
  }

  console.log("All issues completed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
