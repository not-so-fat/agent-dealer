/**
 * Run all integration PoCs; log to .temporal/logs/poc-integration.log
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentDealerEnv } from "../load-env.ts";

loadAgentDealerEnv();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const logDir = path.join(root, ".temporal/logs");
const logPath = path.join(logDir, "poc-integration.log");

const scripts: Array<{ name: string; args?: string[]; skip?: () => boolean }> = [
  { name: "linear-inbox.ts" },
  { name: "agent-deck-decks.ts" },
  { name: "claude-minimal.ts" },
  { name: "cursor-agent-probe.ts", args: ["--quick"] },
  {
    name: "agent-deck-send.ts",
    skip: () => !process.env.SEND_POC_SERVICE_ID || !process.env.SEND_POC_CHANNEL,
  },
];

async function runScript(name: string, extraArgs: string[] = []): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", path.join(root, "scripts/poc", name), ...extraArgs], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    const append = (s: string) => {
      buf += s;
      process.stdout.write(s);
    };
    child.stdout?.on("data", (b: Buffer) => append(b.toString()));
    child.stderr?.on("data", (b: Buffer) => append(b.toString()));
    child.on("close", (code) => {
      fs.appendFileSync(logPath, `\n=== ${name} exit ${code} ===\n${buf}\n`);
      resolve(code ?? 1);
    });
  });
}

async function main(): Promise<void> {
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(logPath, `poc-integration ${new Date().toISOString()}\n`);

  let failed = 0;
  for (const s of scripts) {
    if (s.skip?.()) {
      console.log(`\n--- ${s.name} --- SKIP (env not set)`);
      continue;
    }
    console.log(`\n--- ${s.name} ---`);
    const code = await runScript(s.name, s.args);
    if (code !== 0) failed++;
  }

  console.log(`\nLog: ${logPath}`);
  if (failed > 0) {
    console.error(`${failed} PoC(s) failed`);
    process.exit(1);
  }
  console.log("All PoCs passed or skipped cleanly");
}

main();
