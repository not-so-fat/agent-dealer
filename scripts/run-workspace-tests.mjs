#!/usr/bin/env node
// Expand bare tokens (e.g. `npm test -w packages/server -- routing`) to matching
// `*.test.ts` files under the workspace, then run them with `tsx --test`.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const cwd = process.cwd();
const patterns = process.argv.slice(2);

function walkTestFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkTestFiles(full, out);
    else if (name.endsWith(".test.ts") || name.endsWith(".test.mts") || name.endsWith(".test.mjs")) {
      out.push(full);
    }
  }
  return out;
}

function expand(token) {
  if (existsSync(token) && statSync(token).isFile()) return [token];
  const all = walkTestFiles(join(cwd, "src")).concat(walkTestFiles(cwd));
  const needle = token.toLowerCase();
  const hits = all.filter((f) => {
    const rel = relative(cwd, f).toLowerCase();
    return rel.includes(needle) || f.toLowerCase().includes(needle);
  });
  // Prefer coordinator/src matches over accidental root hits when both exist.
  const unique = [...new Set(hits)];
  return unique;
}

let files;
if (patterns.length === 0) {
  files = walkTestFiles(join(cwd, "src"));
  if (files.length === 0) files = walkTestFiles(cwd);
} else {
  files = [];
  for (const p of patterns) {
    const expanded = expand(p);
    if (expanded.length === 0) {
      console.error(`No test files matched: ${p}`);
      process.exit(1);
    }
    files.push(...expanded);
  }
  files = [...new Set(files)];
}

if (files.length === 0) {
  console.error("No test files found");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...files],
  { stdio: "inherit", cwd, env: process.env }
);
process.exit(result.status ?? 1);
