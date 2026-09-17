// packages/server/src/resolve-tsx-bin.ts
//
// Test-support only: locates `node_modules/.bin/tsx` the way Node resolves modules, by
// walking up from the repo root. A git worktree has no node_modules of its own and
// resolves everything from the main checkout above it, so hardcoding
// `<repoRoot>/node_modules` makes every spawning test fail with ENOENT when the suite runs
// from a worktree. Shared by the tests that spawn a real tsx child process.
import fs from "node:fs";
import path from "node:path";

export function resolveTsxBin(fromDir: string): string {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", ".bin", "tsx");
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) {
      throw new Error(`could not find node_modules/.bin/tsx at or above ${fromDir}`);
    }
  }
}
