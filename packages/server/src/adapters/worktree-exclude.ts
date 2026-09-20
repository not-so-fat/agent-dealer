// Keeps a coordinator-written path inside a worktree out of the worker's `git add` and out of the
// clean-worktree check, without touching any tracked file. Shared by the Cursor MCP config
// (agent-deck-bind.ts) and the per-attempt Muse config (coordinator/muse-spawn.ts).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Append `line` (a root-anchored gitignore pattern such as `/.cursor/mcp.json`) idempotently to
 * git's info/exclude.
 *
 * For a linked worktree, `git rev-parse --git-path info/exclude` resolves to the *main*
 * repository's `.git/info/exclude` (shared across all worktrees of that repo), not a per-worktree
 * file. A root-anchored pattern is still correct per worktree root; the file is rewritten with a
 * single occurrence so concurrent preparations can't leave duplicate lines.
 */
export function ensureWorktreeExcluded(worktreePath: string, line: string): void {
  let excludePathOut: string;
  try {
    excludePathOut = execFileSync("git", ["-C", worktreePath, "rev-parse", "--git-path", "info/exclude"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { stderr?: string };
    throw new Error(`could not resolve git info/exclude: ${e.stderr || String(err) || "unknown error"}`);
  }
  const excludePath = path.resolve(worktreePath, excludePathOut.trim());
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  let existing = "";
  try {
    existing = fs.readFileSync(excludePath, "utf8");
  } catch {
    existing = "";
  }
  const kept = existing.split(/\r?\n/).filter((l) => l.trim() !== "" && l.trim() !== line);
  kept.push(line);
  fs.writeFileSync(excludePath, `${kept.join("\n")}\n`, { mode: 0o644 });
}
