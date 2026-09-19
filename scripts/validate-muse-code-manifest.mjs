#!/usr/bin/env node
// Validates docs/evaluations/muse-code/tasks.json (NOT-176): shape, coverage minimums, and that
// every pinned commit is real and consistent. Read-only; needs the full commit history.
//
//   node scripts/validate-muse-code-manifest.mjs [--ready] [path/to/tasks.json]
//
// --ready is the pre-run gate: it additionally fails until the operator has confirmed the frozen
// candidate model against the contributor tier (candidate.confirmation.confirmedAt/confirmedBy).
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const ready = args.includes("--ready");
const file = args.find((a) => !a.startsWith("--")) ?? "docs/evaluations/muse-code/tasks.json";
const errors = [];
const fail = (msg) => errors.push(msg);

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function gitOk(...args) {
  try {
    git(...args);
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

const ROLES = new Set(["developer", "reviewer"]);
const CATEGORIES = new Set(["implementation", "test_debug", "repository_exploration", "review"]);
const SIZES = new Set(["small", "medium", "long"]);
const SHA = /^[0-9a-f]{40}$/;
const str = (v) => typeof v === "string" && v.trim().length > 0;

for (const side of ["baseline", "candidate"]) {
  if (typeof manifest[side] !== "object" || manifest[side] === null) fail(`missing ${side}`);
}
// Every compared subject is frozen: an explicit runtime, model id, effort, CLI version and invocation.
// null or a generic description ("current model", CLI default) is a failure, not a valid value.
const subjects = {
  "baseline.developer": manifest.baseline?.developer,
  "baseline.reviewer": manifest.baseline?.reviewer,
  candidate: manifest.candidate,
};
for (const [name, s] of Object.entries(subjects)) {
  if (!s || !str(s.runtime) || !str(s.model) || !str(s.effort) || !str(s.cliVersion) || !str(s.frozenInvocation) || !str(s.pricingBasis)) {
    fail(`${name} must freeze non-null runtime, model, effort, cliVersion, frozenInvocation and pricingBasis`);
    continue;
  }
  if (/\b(current|default|latest)\b/i.test(`${s.model} ${s.effort}`) || /\s/.test(s.model)) {
    fail(`${name}: model/effort must be explicit identifiers, not descriptions (${s.model} / ${s.effort})`);
  }
  if (!s.frozenInvocation.includes(s.model) || !s.frozenInvocation.includes(s.effort)) {
    fail(`${name}: frozenInvocation must pass the frozen model (${s.model}) and effort (${s.effort}) explicitly`);
  }
}
const c = manifest.candidate;
if (c?.runtime !== "muse_code") fail("candidate must be runtime muse_code");
if (c?.privacy?.allowedTaskClassification !== "non_sensitive") {
  fail("candidate.privacy.allowedTaskClassification must be non_sensitive");
}
if (ready && (!str(c?.confirmation?.confirmedAt) || !str(c?.confirmation?.confirmedBy))) {
  fail("--ready: candidate.confirmation.confirmedAt/confirmedBy not set; confirm the frozen model against the contributor tier first");
}

const loop = manifest.controls?.reviewLoop;
if (!loop || !Number.isInteger(loop.maxReviewerRounds) || loop.maxReviewerRounds < 2 || !str(loop.protocol) ||
    !Array.isArray(loop.countedVerdicts) || !loop.countedVerdicts.includes("changes_requested")) {
  fail("controls.reviewLoop must define maxReviewerRounds (>= 2), countedVerdicts (incl. changes_requested) and protocol");
}

const tasks = manifest.tasks;
if (!Array.isArray(tasks) || tasks.length !== 12) {
  fail(`tasks must contain exactly 12 entries (found ${Array.isArray(tasks) ? tasks.length : "none"})`);
}

const ids = new Set();
for (const t of Array.isArray(tasks) ? tasks : []) {
  const where = `task ${t?.id ?? "(no id)"}`;
  if (!str(t.id) || ids.has(t.id)) fail(`${where}: id missing or duplicated`);
  ids.add(t.id);
  if (!str(t.sourceIssue)) fail(`${where}: sourceIssue missing`);
  if (!str(t.repository)) fail(`${where}: repository missing`);
  if (!ROLES.has(t.role)) fail(`${where}: bad role ${t.role}`);
  if (!CATEGORIES.has(t.category)) fail(`${where}: bad category ${t.category}`);
  if (!SIZES.has(t.sizeClass)) fail(`${where}: bad sizeClass ${t.sizeClass}`);
  if (!Number.isInteger(t.timeoutSeconds) || t.timeoutSeconds <= 0) fail(`${where}: timeoutSeconds missing`);
  if (t.sensitivity?.classification !== "non_sensitive" || !str(t.sensitivity?.rationale)) {
    fail(`${where}: sensitivity must be non_sensitive with a rationale`);
  }
  const spec = t.workerSpec;
  if (!spec || !str(spec.title) || !str(spec.description) || !Array.isArray(spec.acceptanceCriteria) || spec.acceptanceCriteria.length === 0) {
    fail(`${where}: workerSpec needs title, description and acceptanceCriteria[]`);
  }
  if (!str(t.expectedArtifact?.type) || !str(t.expectedArtifact?.description)) fail(`${where}: expectedArtifact incomplete`);
  const cmds = t.verification?.commands;
  if (!Array.isArray(cmds) || cmds.length === 0) fail(`${where}: verification.commands missing`);
  for (const cmd of cmds ?? []) {
    if (!str(cmd.id) || !str(cmd.run) || !Number.isInteger(cmd.expectedExitCode) || !str(cmd.expectedResult)) {
      fail(`${where}: verification command ${cmd?.id ?? "?"} needs id, run, expectedExitCode, expectedResult`);
    }
  }

  // Deterministic graders: exploration answers are checked against a structured answerKey and review
  // results against knownDefects with file + evidence patterns, never against keyword presence.
  const graderCmds = (cmds ?? []).filter((cmd) => str(cmd.run) && cmd.run.includes("$EVAL_ROOT/scripts/grade-muse-code.mjs"));
  if (t.category === "repository_exploration") {
    if (!t.verification?.answerKey || typeof t.verification.answerKey !== "object") fail(`${where}: exploration task needs verification.answerKey`);
    if (!graderCmds.some((cmd) => cmd.run.includes(` answer ${t.id} `))) fail(`${where}: no structured 'answer' grader command`);
    if (!t.workerSpec?.description?.includes("exactly one fenced")) fail(`${where}: workerSpec must require the structured JSON answer block`);
  }
  if (t.role === "reviewer") {
    const kd = t.verification?.knownDefects;
    if (!Array.isArray(kd) || kd.length === 0) fail(`${where}: reviewer task needs structured knownDefects`);
    for (const d of Array.isArray(kd) ? kd : []) {
      if (!str(d?.id) || !Array.isArray(d.files) || d.files.length === 0 || !Array.isArray(d.evidence) || d.evidence.length < 2) {
        fail(`${where}: knownDefect ${d?.id ?? "?"} needs id, files[] and at least two evidence groups`);
        continue;
      }
      for (const f of d.files) if (!gitOk("cat-file", "-e", `${t.startingSha}:${f}`)) fail(`${where}: defect ${d.id} file ${f} does not exist at startingSha`);
      for (const src of d.evidence.flat()) {
        try {
          new RegExp(src, "i");
        } catch {
          fail(`${where}: defect ${d.id} has an invalid pattern ${src}`);
        }
      }
    }
    if (!graderCmds.some((cmd) => cmd.run.includes(` review ${t.id} `))) fail(`${where}: no structured 'review' grader command`);
    if (t.verification?.expectedShas?.headSha !== t.startingSha) fail(`${where}: expectedShas.headSha must equal startingSha`);
  }

  // Pinned commits are real, and the reference (if any) descends from the starting SHA.
  if (!SHA.test(t.startingSha ?? "")) {
    fail(`${where}: startingSha must be a full 40-hex SHA`);
  } else if (!gitOk("cat-file", "-e", `${t.startingSha}^{commit}`)) {
    fail(`${where}: startingSha ${t.startingSha} is not a commit in this repository`);
  }
  if (t.referenceSha !== null && t.referenceSha !== undefined) {
    if (!SHA.test(t.referenceSha)) {
      fail(`${where}: referenceSha must be a full 40-hex SHA or null`);
    } else if (!gitOk("cat-file", "-e", `${t.referenceSha}^{commit}`)) {
      fail(`${where}: referenceSha ${t.referenceSha} is not a commit in this repository`);
    } else if (SHA.test(t.startingSha ?? "") && !gitOk("merge-base", "--is-ancestor", t.startingSha, t.referenceSha)) {
      fail(`${where}: startingSha is not an ancestor of referenceSha`);
    }
    for (const p of t.verification?.heldOutPaths ?? []) {
      if (!gitOk("cat-file", "-e", `${t.referenceSha}:${p}`)) fail(`${where}: held-out path ${p} does not exist at referenceSha`);
      if (!cmds?.some((cmd) => cmd.run.includes(p))) fail(`${where}: no verification command references held-out path ${p}`);
    }
  } else if ((t.verification?.heldOutPaths ?? []).length > 0) {
    fail(`${where}: heldOutPaths requires a referenceSha`);
  }
}

if (!fs.existsSync("scripts/grade-muse-code.mjs")) fail("scripts/grade-muse-code.mjs is missing");

// Coverage minimums from the NOT-176 contract.
const list = Array.isArray(tasks) ? tasks : [];
const count = (fn) => list.filter(fn).length;
const coverage = {
  implementation: count((t) => t.category === "implementation"),
  test_debug: count((t) => t.category === "test_debug"),
  repository_exploration: count((t) => t.category === "repository_exploration"),
  reviewer: count((t) => t.role === "reviewer"),
  medium_or_long: count((t) => t.sizeClass === "medium" || t.sizeClass === "long"),
};
const minimums = { implementation: 6, test_debug: 2, repository_exploration: 2, reviewer: 1, medium_or_long: 1 };
for (const [k, min] of Object.entries(minimums)) {
  if (coverage[k] < min) fail(`coverage: need at least ${min} ${k} task(s), found ${coverage[k]}`);
}

if (errors.length > 0) {
  console.error(`FAIL: ${errors.length} problem(s) in ${file}`);
  for (const e of errors) console.error(` - ${e}`);
  process.exit(1);
}
console.log(`OK: ${file}: ${list.length} tasks; coverage ${JSON.stringify(coverage)}; all pinned commits resolve.`);
