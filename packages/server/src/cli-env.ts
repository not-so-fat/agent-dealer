import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Paths where Claude Code / Cursor CLI are commonly installed outside login-shell PATH. */
function commonCliDirs(home: string): string[] {
  return [
    path.join(home, ".local/bin"),
    path.join(home, ".cursor/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

/**
 * Prepend common CLI install dirs to PATH.
 * Cursor/npm dev servers often inherit a minimal PATH without ~/.local/bin from .zshrc.
 */
export function enrichPathForCliTools(): void {
  const home = process.env.HOME ?? os.homedir();
  const prepend = commonCliDirs(home);
  const current = process.env.PATH ?? "";
  const parts = [...prepend, ...current.split(path.delimiter)].filter(
    (p, i, arr) => p.length > 0 && arr.indexOf(p) === i
  );
  process.env.PATH = parts.join(path.delimiter);
}

function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Resolve Claude Code binary — avoids PATH misses in IDE-spawned servers. */
export function resolveClaudeBin(): string {
  const home = process.env.HOME ?? os.homedir();
  if (process.env.CLAUDE_CLI) return process.env.CLAUDE_CLI;
  return (
    firstExisting([
      path.join(home, ".local/bin/claude"),
      path.join(home, ".cursor/bin/claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ]) ?? "claude"
  );
}

/** Resolve Cursor CLI binary. */
export function resolveCursorBin(): string {
  const home = process.env.HOME ?? os.homedir();
  if (process.env.CURSOR_CLI) return process.env.CURSOR_CLI;
  return (
    firstExisting([
      path.join(home, ".local/bin/cursor"),
      path.join(home, ".cursor/bin/cursor"),
      "/opt/homebrew/bin/cursor",
      "/usr/local/bin/cursor",
    ]) ?? "cursor"
  );
}

export function claudeBinExists(): boolean {
  const bin = resolveClaudeBin();
  return bin !== "claude" ? fs.existsSync(bin) : false;
}

export function cursorBinExists(): boolean {
  const bin = resolveCursorBin();
  return bin !== "cursor" ? fs.existsSync(bin) : false;
}
