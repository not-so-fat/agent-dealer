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

/** Match server cli-env resolution for Cursor Agent CLI. */
export function resolveCursorBin(): string {
  const home = process.env.HOME ?? os.homedir();
  if (process.env.CURSOR_CLI) return process.env.CURSOR_CLI;
  const candidates = [
    path.join(home, ".local/bin/cursor-agent"),
    path.join(home, ".cursor/bin/cursor-agent"),
    "/opt/homebrew/bin/cursor-agent",
    "/usr/local/bin/cursor-agent",
    path.join(home, ".local/bin/cursor"),
    path.join(home, ".cursor/bin/cursor"),
    "/opt/homebrew/bin/cursor",
    "/usr/local/bin/cursor",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "cursor-agent";
}

export function cursorInvokeArgs(args: string[]): string[] {
  const bin = resolveCursorBin();
  if (path.basename(bin) === "cursor") return ["agent", ...args];
  return args;
}

export async function claudeAvailable(): Promise<{ ok: boolean; bin: string }> {
  const bin = resolveClaudeBin();
  if (bin !== "claude") return { ok: true, bin };
  return new Promise((resolve) => {
    spawn("which", ["claude"]).on("close", (code) => resolve({ ok: code === 0, bin }));
  });
}

export async function cursorAvailable(): Promise<{ ok: boolean; bin: string }> {
  const bin = resolveCursorBin();
  if (bin !== "cursor-agent" && bin !== "cursor") return { ok: true, bin };
  return new Promise((resolve) => {
    spawn("which", ["cursor-agent"]).on("close", (code) => {
      if (code === 0) resolve({ ok: true, bin: "cursor-agent" });
      else spawn("which", ["cursor"]).on("close", (c2) => resolve({ ok: c2 === 0, bin: "cursor" }));
    });
  });
}
