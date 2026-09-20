#!/usr/bin/env node
// Deterministic graders for the Muse Code evaluation manifest (NOT-176). The grader lives in
// the Dealer checkout that holds the contract ($EVAL_ROOT), never in the worker's worktree, so
// a worker at its pinned SHA cannot read the answer keys.
//
//   node scripts/grade-muse-code.mjs answer <taskId> <artifact.md>   # structured exploration answer
//   node scripts/grade-muse-code.mjs review <taskId> <artifact.md>   # reviewer result vs claim catalogue
//
// Nothing here is graded by matching free prose. Exploration answers are compared field by field to
// exact normalized identifiers, booleans and enumerated values. Reviewer results assert defects
// through an explicit, closed vocabulary (`claim:<id>` fingerprints), so polarity is structural: a
// finding that carries a claim id asserts that claim, and prose cannot flip it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = path.join(HERE, "..", "docs", "evaluations", "muse-code", "tasks.json");

const FENCE = /```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```/g;

/** The single fenced JSON block of an artifact, or an error. Two blocks are ambiguous and fail. */
export function extractSingleJsonBlock(text) {
  const blocks = [...text.matchAll(FENCE)].map((m) => m[1]);
  if (blocks.length !== 1) return { error: `expected exactly one fenced JSON block, found ${blocks.length}` };
  try {
    return { value: JSON.parse(blocks[0]) };
  } catch (err) {
    return { error: `fenced block is not valid JSON: ${err.message}` };
  }
}

const norm = (s) =>
  typeof s === "string"
    ? s
        .trim()
        .replace(/^`+|`+$/g, "")
        .replace(/^\.\//, "")
        .replace(/\(\)$/, "")
    : s;
const isLeaf = (spec) => spec && typeof spec === "object" && Object.keys(spec).some((k) => k.startsWith("$"));

/** Compare `value` to the answer-key `spec`; push a message per mismatch. */
export function checkSpec(spec, value, where, problems) {
  if (isLeaf(spec)) {
    if ("$equals" in spec) {
      const same = typeof spec.$equals === "string" ? norm(value) === spec.$equals : value === spec.$equals;
      if (!same) problems.push(`${where}: expected ${JSON.stringify(spec.$equals)}, got ${JSON.stringify(value)}`);
    }
    if ("$oneOf" in spec) {
      const got = norm(value);
      if (typeof got !== "string" || !spec.$oneOf.includes(got)) {
        problems.push(`${where}: expected exactly one of ${JSON.stringify(spec.$oneOf)}, got ${JSON.stringify(value)}`);
      }
    }
    if ("$setEquals" in spec) {
      const got = Array.isArray(value) ? [...new Set(value.map(norm))].sort() : null;
      const want = [...new Set(spec.$setEquals)].sort();
      if (!got || got.length !== want.length || got.some((v, i) => v !== want[i])) {
        problems.push(`${where}: expected exactly ${JSON.stringify(want)}, got ${JSON.stringify(value)}`);
      }
    }
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    problems.push(`${where}: expected an object, got ${JSON.stringify(value)}`);
    return;
  }
  for (const [key, sub] of Object.entries(spec)) {
    checkSpec(sub, value[key], `${where}.${key}`, problems);
  }
}

export function gradeAnswer(task, artifactText) {
  const key = task.verification?.answerKey;
  if (!key) return { ok: false, problems: [`task ${task.id} has no verification.answerKey`] };
  const parsed = extractSingleJsonBlock(artifactText);
  if (parsed.error) return { ok: false, problems: [parsed.error] };
  const problems = [];
  checkSpec(key, parsed.value, "answer", problems);
  return { ok: problems.length === 0, problems };
}

const VERDICTS = new Set(["approved", "changes_requested", "escalated"]);

/** Mirror of packages/server/src/coordinator/reviewer-result.ts, so grading needs no worker tree. */
export function parseReviewerResultStrict(text) {
  const parsed = extractSingleJsonBlock(text);
  if (parsed.error) return { error: parsed.error };
  const r = parsed.value;
  const str = (v) => typeof v === "string";
  if (!r || typeof r !== "object" || !VERDICTS.has(r.verdict) || !str(r.baseSha) || !str(r.headSha)) {
    return { error: "not a ReviewerResult (verdict/baseSha/headSha)" };
  }
  if (!str(r.acceptanceCriteriaAssessment) || !str(r.evidenceAssessment)) return { error: "not a ReviewerResult (assessments)" };
  if (!Array.isArray(r.risks) || !r.risks.every(str)) return { error: "not a ReviewerResult (risks)" };
  if (!Array.isArray(r.findings)) return { error: "not a ReviewerResult (findings)" };
  for (const f of r.findings) {
    const okShape =
      f && str(f.fingerprint) && (f.severity === "blocking" || f.severity === "non_blocking") && str(f.title) && str(f.rationale);
    const okOptional = (f.file === undefined || str(f.file)) && (f.line === undefined || Number.isInteger(f.line));
    if (!okShape || !okOptional) return { error: "not a ReviewerResult (finding shape)" };
  }
  return { value: r };
}

const CLAIM_PREFIX = "claim:";

/**
 * Grade a reviewer result against the task's claim catalogue (`verification.claims`, restated in the
 * worker spec). Each finding whose fingerprint is `claim:<id>` asserts that claim; the finding must
 * name one of the claim's files. Claims are either true (`holds: true`, a real defect) or false
 * decoys (`holds: false`). Passing needs: the pinned SHAs, a non-approved verdict, at least
 * `minHeldClaims` distinct true claims asserted, no false claim asserted, and no unknown claim id.
 * Asserting a claim you find false is not a thing the format lets you do: report only what holds.
 */
export function gradeReview(task, artifactText) {
  const claims = task.verification?.claims;
  if (!Array.isArray(claims) || claims.length === 0) return { ok: false, problems: [`task ${task.id} has no verification.claims`] };
  const parsed = parseReviewerResultStrict(artifactText);
  if (parsed.error) return { ok: false, problems: [parsed.error] };
  const r = parsed.value;
  const problems = [];
  const want = task.verification.expectedShas;
  if (r.baseSha !== want.baseSha || r.headSha !== want.headSha) problems.push("wrong baseSha/headSha");
  if (r.verdict !== "changes_requested") problems.push(`verdict must be changes_requested when defects are asserted, got ${r.verdict}`);

  const byId = new Map(claims.map((c) => [c.id, c]));
  const matched = new Set();
  for (const f of r.findings) {
    if (!f.fingerprint.startsWith(CLAIM_PREFIX)) continue;
    const id = f.fingerprint.slice(CLAIM_PREFIX.length);
    const claim = byId.get(id);
    if (!claim) {
      problems.push(`unknown claim id ${JSON.stringify(id)}`);
    } else if (!claim.holds) {
      problems.push(`asserted false claim ${id}`);
    } else if (typeof f.file !== "string" || !claim.files.includes(norm(f.file))) {
      problems.push(`claim ${id} finding must name one of ${JSON.stringify(claim.files)}, got ${JSON.stringify(f.file)}`);
    } else {
      matched.add(id);
    }
  }
  const need = task.verification.minHeldClaims ?? 1;
  if (matched.size < need) problems.push(`asserted ${matched.size} true claim(s), need at least ${need}`);
  const total = claims.filter((c) => c.holds).length;
  return { ok: problems.length === 0, problems, matched: [...matched], total };
}

function main(argv) {
  const [mode, taskId, artifact] = argv;
  if (!["answer", "review"].includes(mode) || !taskId || !artifact) {
    console.error("usage: grade-muse-code.mjs <answer|review> <taskId> <artifact.md>");
    return 2;
  }
  const manifest = JSON.parse(fs.readFileSync(process.env.MUSE_CODE_MANIFEST ?? DEFAULT_MANIFEST, "utf8"));
  const task = manifest.tasks.find((t) => t.id === taskId);
  if (!task) {
    console.error(`unknown task ${taskId}`);
    return 2;
  }
  const result = (mode === "answer" ? gradeAnswer : gradeReview)(task, fs.readFileSync(artifact, "utf8"));
  if (!result.ok) {
    for (const p of result.problems) console.error(`FAIL: ${p}`);
    return 1;
  }
  console.log(mode === "review" ? `ok (matched ${result.matched.join(", ")}; ${result.matched.length}/${result.total})` : "ok");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
