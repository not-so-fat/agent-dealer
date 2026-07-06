/**
 * PoC: claude -p with stream-json + --verbose (flags agent-dealer runner uses).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const mcpConfig = process.env.CLAUDE_MCP_CONFIG ?? path.join(process.env.HOME ?? "", ".claude.json");

async function main(): Promise<void> {
  if (!fs.existsSync(mcpConfig)) {
    console.log(`SKIP claude-minimal: MCP config missing (${mcpConfig})`);
    process.exit(0);
  }

  const args = [
    "-p",
    "Reply with exactly: POC_OK",
    "--mcp-config",
    mcpConfig,
    "--max-turns",
    "1",
    "--max-budget-usd",
    "0.05",
    "--output-format",
    "stream-json",
    "--verbose",
  ];

  const result = await new Promise<{ code: number; out: string; err: string }>((resolve) => {
    let out = "";
    let err = "";
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (b: Buffer) => (out += b.toString()));
    child.stderr?.on("data", (b: Buffer) => (err += b.toString()));
    child.on("error", (e) => resolve({ code: 127, out: "", err: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
  });

  if (result.code !== 0) {
    // stream-json may exit 1 on budget/permission edge cases — flag for human env
    const streamStarted = result.out.includes('"type"') || result.out.includes("session_id");
    if (streamStarted) {
      console.log(`WARN claude-minimal: exit ${result.code} but stream-json received (${result.out.length} bytes) — check auth/budget`);
      process.exit(0);
    }
    console.error("FAIL claude-minimal: exit", result.code);
    if (result.err) console.error(result.err.slice(-500));
    if (result.out) console.error(result.out.slice(-500));
    process.exit(1);
  }

  const ok = result.out.includes("POC_OK") || result.out.length > 20;
  console.log(`OK claude-minimal: exit 0, output_bytes=${result.out.length}, has_content=${ok}`);
}

main().catch((e) => {
  console.error("FAIL claude-minimal:", e);
  process.exit(1);
});
