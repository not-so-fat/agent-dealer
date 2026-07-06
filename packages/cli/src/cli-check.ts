import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Match server cli-env resolution for doctor checks. */
export function resolveClaudeBin(): string {
  const home = process.env.HOME ?? os.homedir();
  if (process.env.CLAUDE_CLI) return process.env.CLAUDE_CLI;
  const candidates = [
    path.join(home, ".local/bin/claude"),
    path.join(home, ".cursor/bin/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "claude";
}

export async function claudeAvailable(): Promise<{ ok: boolean; bin: string }> {
  const bin = resolveClaudeBin();
  if (bin !== "claude") return { ok: true, bin };
  return new Promise((resolve) => {
    spawn("which", ["claude"]).on("close", (code) => resolve({ ok: code === 0, bin }));
  });
}
