#!/usr/bin/env node
// Validates docs/evaluations/muse-code/tasks.json (NOT-176): shape, coverage minimums, frozen subjects,
// and that every pinned commit and held-out test path is real. Read-only; needs the full commit history.
//
//   node scripts/validate-muse-code-manifest.mjs [path/to/tasks.json]
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const file = process.argv[2] ?? "docs/evaluations/muse-code/tasks.json";
const errors = [];
const fail = (msg) => errors.push(msg);
const str = (v) => typeof v === "string" && v.trim().length > 0;
const SHA = /^[0-9a-f]{40}$/;

function gitOk(...args) {
  try {
    execFileSync("git", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (err) {
  console.error(`FAIL: ${file} is not readable JSON: ${err.message}`);
  process.exit(1);
}

// Both compared subjects are frozen: explicit runtime, model id, effort, CLI version and invocation.
// A null or a description ("current model", CLI default) is a failure, not a value.
const subjects = { "baseline.developer": manifest.baseline?.developer, candidate: manifest.candidate };
for (const [name, s] of Object.entries(subjects)) {
  if (!s || !str(s.runtime) || !str(s.model) || !str(s.effort) || !str(s.cliVersion) || !str(s.frozenInvocation)) {
    fail(`${name} must freeze non-null runtime, model, effort, cliVersion and frozenInvocation`);
    continue;
  }
  if (/\b(current|default|latest)\b/i.test(s.model) || /\s/.test(s.model)) fail(`${name}: model must be an explicit id, got "${s.model}"`);
  if (!s.frozenInvocation.includes(s.model)) fail(`${name}: frozenInvocation must pass the frozen model ${s.model} explicitly`);
}
if (manifest.candidate?.runtime !== "muse_code") fail("candidate must be runtime muse_code");
if (manifest.candidate?.privacy?.allowedTaskClassification !== "non_sensitive") {
  fail("candidate.privacy.allowedTaskClassification must be non_sensitive");
}

// One frozen cost basis with disjoint token quantities, so cached input is never charged at two rates.
const cm = manifest.costModel;
if (cm?.basis !== "list_rate_shadow_cost" || !str(cm.formula) || !str(cm.nullRule) || !cm.disjointQuantities) {
  fail("costModel must freeze basis list_rate_shadow_cost with formula, disjointQuantities and nullRule");
} else {
  for (const k of ["uncached_input", "cache_read", "cache_write", "output"]) {
    if (!str(cm.disjointQuantities[k])) fail(`costModel.disjointQuantities.${k} missing`);
  }
}

const tasks = Array.isArray(manifest.tasks) ? manifest.tasks : [];
if (tasks.length !== 5) fail(`tasks must contain exactly 5 entries (found ${tasks.length})`);

const ids = new Set();
for (const t of tasks) {
  const where = `task ${t?.id ?? "(no id)"}`;
  if (!str(t.id) || ids.has(t.id)) fail(`${where}: id missing or duplicated`);
  ids.add(t.id);
  if (!str(t.sourceIssue) || !str(t.repository)) fail(`${where}: sourceIssue and repository are required`);
  if (t.role !== "developer") fail(`${where}: role must be developer in the PoC`);
  if (!["implementation", "test_debug"].includes(t.category)) fail(`${where}: bad category ${t.category}`);
  if (!["small", "medium", "long"].includes(t.sizeClass)) fail(`${where}: bad sizeClass ${t.sizeClass}`);
  if (!Number.isInteger(t.timeoutSeconds) || t.timeoutSeconds <= 0) fail(`${where}: timeoutSeconds missing`);
  if (t.sensitivity?.classification !== "non_sensitive" || !str(t.sensitivity?.rationale)) {
    fail(`${where}: sensitivity must be non_sensitive with a rationale`);
  }
  const spec = t.workerSpec;
  if (!spec || !str(spec.title) || !str(spec.description) || !Array.isArray(spec.acceptanceCriteria) || spec.acceptanceCriteria.length === 0) {
    fail(`${where}: workerSpec needs title, description and acceptanceCriteria[]`);
  }
  const cmds = t.verification?.commands;
  if (!Array.isArray(cmds) || cmds.length === 0) fail(`${where}: verification.commands missing`);
  for (const cmd of cmds ?? []) {
    if (!str(cmd.id) || !str(cmd.run) || !Number.isInteger(cmd.expectedExitCode) || !str(cmd.expectedResult)) {
      fail(`${where}: verification command ${cmd?.id ?? "?"} needs id, run, expectedExitCode, expectedResult`);
    }
  }

  // Pinned commits are real, and the reference descends from the starting SHA.
  for (const key of ["startingSha", "referenceSha"]) {
    if (!SHA.test(t[key] ?? "")) fail(`${where}: ${key} must be a full 40-hex SHA`);
    else if (!gitOk("cat-file", "-e", `${t[key]}^{commit}`)) fail(`${where}: ${key} ${t[key]} is not a commit in this repository`);
  }
  if (SHA.test(t.startingSha ?? "") && SHA.test(t.referenceSha ?? "") && !gitOk("merge-base", "--is-ancestor", t.startingSha, t.referenceSha)) {
    fail(`${where}: startingSha is not an ancestor of referenceSha`);
  }
  // Held-out tests come from referenceSha, and a verification command must actually run them.
  const held = t.verification?.heldOutPaths ?? [];
  if (held.length === 0) fail(`${where}: verification.heldOutPaths is required (tests the worker never sees)`);
  for (const p of held) {
    if (!gitOk("cat-file", "-e", `${t.referenceSha}:${p}`)) fail(`${where}: held-out path ${p} does not exist at referenceSha`);
    if (!cmds?.some((cmd) => cmd.run.includes(p))) fail(`${where}: no verification command references held-out path ${p}`);
  }
}

// Coverage minimums from the NOT-176 contract.
const coverage = {
  implementation: tasks.filter((t) => t.category === "implementation").length,
  test_debug: tasks.filter((t) => t.category === "test_debug").length,
  medium_or_long: tasks.filter((t) => t.sizeClass === "medium" || t.sizeClass === "long").length,
};
const minimums = { implementation: 3, test_debug: 1, medium_or_long: 1 };
for (const [k, min] of Object.entries(minimums)) {
  if (coverage[k] < min) fail(`coverage: need at least ${min} ${k} task(s), found ${coverage[k]}`);
}

if (errors.length > 0) {
  console.error(`FAIL: ${errors.length} problem(s) in ${file}`);
  for (const e of errors) console.error(` - ${e}`);
  process.exit(1);
}
console.log(`OK: ${file}: ${tasks.length} tasks; coverage ${JSON.stringify(coverage)}; all pinned commits resolve.`);
