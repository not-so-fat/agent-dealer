#!/usr/bin/env node
/**
 * Deterministic release pipeline (docs/PUBLISHING.md).
 *
 *   node scripts/release.mjs check
 *   node scripts/release.mjs prepare <patch|minor|major|X.Y.Z> --summary "<one line>"
 *   node scripts/release.mjs finish
 *
 * `prepare` bumps every manifest + internal pin + lockfile, stubs the CHANGELOG from git log,
 * runs build:release + install:smoke and opens the release PR. `finish` waits for CI, squash-merges,
 * tags and creates the GitHub release. npm publish stays with the human (npm run publish:packages).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEP_KEYS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const EXACT = /^\d+\.\d+\.\d+$/;

const run = (cmd, args, opts = {}) => {
  console.log(`[release] $ ${cmd} ${args.join(" ")}`);
  return execFileSync(cmd, args, { cwd: root, stdio: opts.capture ? ["ignore", "pipe", "inherit"] : "inherit", encoding: "utf8" });
};
const out = (cmd, args) => run(cmd, args, { capture: true }).trim();
const die = (msg) => {
  console.error(`[release] ${msg}`);
  process.exit(1);
};

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
const writeJson = (p, v) => fs.writeFileSync(path.join(root, p), `${JSON.stringify(v, null, 2)}\n`);

function manifestPaths() {
  const paths = ["package.json"];
  for (const dir of ["apps", "packages"]) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      const p = `${dir}/${name}/package.json`;
      if (fs.existsSync(path.join(root, p))) paths.push(p);
    }
  }
  return paths;
}

function internalNames(paths) {
  return new Set(paths.map((p) => readJson(p).name));
}

/** Returns a list of mismatches against the root version; empty when consistent. */
function versionProblems() {
  const paths = manifestPaths();
  const names = internalNames(paths);
  const version = readJson("package.json").version;
  const problems = [];
  for (const p of paths) {
    const m = readJson(p);
    if (m.version !== version) problems.push(`${p}: version ${m.version} != ${version}`);
    for (const key of DEP_KEYS) {
      for (const [dep, spec] of Object.entries(m[key] ?? {})) {
        if (names.has(dep) && spec !== version) problems.push(`${p}: ${key}.${dep} ${spec} != ${version}`);
      }
    }
  }
  const lock = readJson("package-lock.json");
  if (lock.version !== version) problems.push(`package-lock.json: version ${lock.version} != ${version}`);
  if (lock.packages?.[""]?.version !== version) problems.push(`package-lock.json: packages[""].version != ${version}`);
  for (const p of paths.filter((x) => x !== "package.json")) {
    const entry = lock.packages?.[path.dirname(p)];
    if (entry && entry.version !== version) problems.push(`package-lock.json: ${path.dirname(p)} ${entry.version} != ${version}`);
  }
  return problems;
}

function bump(current, level) {
  if (EXACT.test(level)) return level;
  const [maj, min, pat] = current.split(".").map(Number);
  if (level === "major") return `${maj + 1}.0.0`;
  if (level === "minor") return `${maj}.${min + 1}.0`;
  if (level === "patch") return `${maj}.${min}.${pat + 1}`;
  return die(`bump must be patch|minor|major|X.Y.Z, got "${level}"`);
}

function setVersion(version) {
  const paths = manifestPaths();
  const names = internalNames(paths);
  for (const p of paths) {
    const m = readJson(p);
    m.version = version;
    for (const key of DEP_KEYS) {
      for (const dep of Object.keys(m[key] ?? {})) {
        if (names.has(dep) && EXACT.test(m[key][dep])) m[key][dep] = version;
      }
    }
    writeJson(p, m);
  }
  run("npm", ["install", "--package-lock-only", "--ignore-scripts"]);
}

function changelogSection(version) {
  const text = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const start = text.indexOf(`## ${version} `);
  if (start < 0) return null;
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next < 0 ? undefined : next).trim();
}

function stubChangelog(version, summary, prevTag) {
  const file = path.join(root, "CHANGELOG.md");
  const text = fs.readFileSync(file, "utf8");
  const subjects = out("git", ["log", `${prevTag}..HEAD`, "--format=%s"]).split("\n").filter(Boolean);
  if (!subjects.length) die(`no commits since ${prevTag}`);
  const date = new Date().toISOString().slice(0, 10);
  const section = `## Unreleased\n\n## ${version} — ${date}\n\n${summary}\n\n### Changes\n\n${subjects.map((s) => `- ${s}`).join("\n")}\n`;
  if (!text.includes("## Unreleased\n")) die("CHANGELOG.md has no '## Unreleased' heading");
  fs.writeFileSync(file, text.replace("## Unreleased\n", section));
}

function check() {
  const problems = versionProblems();
  if (problems.length) die(`version drift:\n  ${problems.join("\n  ")}`);
  console.log("[release] versions consistent");
}

function prepare(level, summary) {
  if (!level || !summary) die('usage: prepare <patch|minor|major|X.Y.Z> --summary "<one line>"');
  if (out("git", ["status", "--porcelain", "--untracked-files=no"])) die("working tree has uncommitted changes");
  if (out("git", ["rev-parse", "--abbrev-ref", "HEAD"]) !== "main") die("run from main");
  run("git", ["fetch", "-q", "origin"]);
  if (out("git", ["rev-parse", "HEAD"]) !== out("git", ["rev-parse", "origin/main"])) die("main is not at origin/main; pull first");
  check();
  const current = readJson("package.json").version;
  const version = bump(current, level);
  const prevTag = `v${current}`;
  console.log(`[release] ${current} -> ${version}`);
  run("git", ["checkout", "-b", `release/${version}`]);
  setVersion(version);
  stubChangelog(version, summary, prevTag);
  check();
  run("npm", ["ci", "--dry-run"]);
  run("npm", ["run", "build:release"]);
  run("npm", ["run", "install:smoke"]);
  run("git", ["add", "CHANGELOG.md", "package-lock.json", ...manifestPaths()]);
  run("git", ["commit", "-q", "-m", `Ship ${version}: ${summary}\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`]);
  run("git", ["push", "-q", "-u", "origin", `release/${version}`]);
  run("gh", ["pr", "create", "--base", "main", "--title", `Ship ${version}: ${summary}`, "--body", `Release ${version}. Version/pins/lockfile synced, build:release and install:smoke pass.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`]);
  console.log(`[release] PR opened. Next: npm run release:finish`);
}

function finish() {
  const branch = out("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const m = /^release\/(\d+\.\d+\.\d+)$/.exec(branch);
  if (!m) die("run from the release/X.Y.Z branch");
  const version = m[1];
  if (readJson("package.json").version !== version) die(`package.json is not ${version}`);
  run("gh", ["pr", "checks", "--watch", "--interval", "20"]);
  run("gh", ["pr", "merge", "--squash", "--delete-branch"]);
  run("git", ["checkout", "-q", "main"]);
  run("git", ["pull", "-q", "origin", "main"]);
  if (readJson("package.json").version !== version) die(`main is not at ${version} after merge`);
  const notes = changelogSection(version) ?? die(`no CHANGELOG section for ${version}`);
  run("git", ["tag", `v${version}`]);
  run("git", ["push", "-q", "origin", `v${version}`]);
  run("gh", ["release", "create", `v${version}`, "--title", `v${version}`, "--notes", notes]);
  console.log(`[release] v${version} released. Publish (human): npm run publish:packages -- --otp=CODE`);
}

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
if (cmd === "check") check();
else if (cmd === "prepare") prepare(rest.find((a) => !a.startsWith("--")), flag("--summary"));
else if (cmd === "finish") finish();
else die("usage: release.mjs check | prepare <bump> --summary <text> | finish");
