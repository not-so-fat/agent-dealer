// Self-test for scripts/grade-muse-code.mjs (NOT-176):  node --test scripts/grade-muse-code.test.mjs
// Each grader must accept a correct deliverable and reject the false positives a keyword grader would pass.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { gradeAnswer, gradeReview } from "./grade-muse-code.mjs";

const manifest = JSON.parse(fs.readFileSync(new URL("../docs/evaluations/muse-code/tasks.json", import.meta.url), "utf8"));
const task = (id) => manifest.tasks.find((t) => t.id === id);
const fence = (o) => "Summary prose.\n```json\n" + JSON.stringify(o, null, 2) + "\n```\n";
const P = "packages/server/src";

const usageAnswer = () => ({
  extractor: { function: "extractSpawnUsage", file: `${P}/coordinator/usage.ts` },
  sources: { tokensIn: "usage.input_tokens", tokensOut: "usage.output_tokens", costUsd: "total_cost_usd" },
  missingValue: "null",
  recordedBy: { developer: `${P}/coordinator/developer-effect.ts`, reviewer: `${P}/coordinator/reviewer-effect.ts` },
  insert: {
    function: "recordUsageEvent",
    file: `${P}/repository/usage-events.ts`,
    table: "usage_events",
    columns: ["id", "issue_id", "worker_session_id", "role", "runtime", "tokens_in", "tokens_out", "cost_usd", "duration_ms", "ts"],
  },
  aggregate: {
    function: "summarizeIssueUsage",
    file: `${P}/repository/usage-events.ts`,
    coalescesMissingToZero: true,
    safeForUnknownCostComparison: false,
  },
});

const readOnlyAnswer = () => ({
  assertion: {
    function: "assertReviewerReadOnly",
    file: `${P}/coordinator/permissions.ts`,
    calledFrom: { function: "realReviewerSpawn", file: `${P}/coordinator/spawn.ts` },
    calledBeforeSpawnCli: true,
  },
  claude: {
    restrictedFlag: "--restricted",
    permissionMode: "dontAsk",
    denyFlag: "--disallowedTools",
    deniedTool: "mcp__agent-deck__call_service_tool",
    deniedToolConstant: "DENY_SEND_TOOL",
    constantFile: `${P}/coordinator/args.ts`,
  },
  codex: {
    deniedTool: "call_service_tool",
    configKey: "disabled_tools",
    verifier: "codexScopedConfigDeniesSendGate",
    verifierFile: `${P}/adapters/codex-scoped-config.ts`,
    verifiedIn: "assertReviewerReadOnly",
  },
  cursor: { deniesOutboundMutation: false, gapReason: "--force is needed headless and the only deny list is the user-global cli-config.json." },
});

test("muse-10 accepts the correct structured answer", () => {
  assert.equal(gradeAnswer(task("muse-10-explore-usage-capture"), fence(usageAnswer())).ok, true);
});

test("muse-10 rejects an answer denying every correct relationship", () => {
  const a = usageAnswer();
  a.extractor.file = `${P}/coordinator/spawn.ts`;
  a.sources = { tokensIn: "usage.output_tokens", tokensOut: "usage.input_tokens", costUsd: "cost" };
  a.missingValue = "0";
  a.recordedBy = { developer: `${P}/coordinator/reviewer-effect.ts`, reviewer: `${P}/coordinator/developer-effect.ts` };
  a.insert.table = "runs";
  a.aggregate.coalescesMissingToZero = false;
  a.aggregate.safeForUnknownCostComparison = true;
  const r = gradeAnswer(task("muse-10-explore-usage-capture"), fence(a));
  assert.equal(r.ok, false);
  assert.ok(r.problems.length >= 8, r.problems.join("\n"));
});

test("muse-10 rejects keyword stuffing without the structured block, and two blocks", () => {
  const prose = "extractSpawnUsage packages/server/src/coordinator/usage.ts recordUsageEvent usage_events summarizeIssueUsage COALESCE null total_cost_usd";
  assert.equal(gradeAnswer(task("muse-10-explore-usage-capture"), prose).ok, false);
  const twice = fence(usageAnswer()) + fence({ ...usageAnswer(), missingValue: "0" });
  assert.equal(gradeAnswer(task("muse-10-explore-usage-capture"), twice).ok, false);
});

test("muse-11 accepts the correct answer and rejects a wrong-relationship one", () => {
  assert.equal(gradeAnswer(task("muse-11-explore-reviewer-read-only"), fence(readOnlyAnswer())).ok, true);
  const bad = readOnlyAnswer();
  bad.assertion.calledBeforeSpawnCli = false;
  bad.cursor.deniesOutboundMutation = true;
  bad.codex.configKey = "allowed_tools";
  bad.claude.permissionMode = "bypassPermissions";
  assert.equal(gradeAnswer(task("muse-11-explore-reviewer-read-only"), fence(bad)).ok, false);
});

const base = "86d9cc644d53830f0457b6b3e8437be13c9cd30a";
const head = "9dda237c316f22d2b2c112048be7a1d1fe9c99f1";
const review = (verdict, findings, shas = { baseSha: base, headSha: head }) =>
  fence({ verdict, ...shas, acceptanceCriteriaAssessment: "ok", evidenceAssessment: "ok", findings, risks: [] });
const finding = (file, title, rationale) => ({ fingerprint: "f", severity: "non_blocking", title, rationale, file, line: 1 });
const t12 = task("muse-12-review-usage-cap-deferral");

test("muse-12 accepts a finding that names a known defect with specific evidence", () => {
  const r = gradeReview(
    t12,
    review("changes_requested", [
      finding(`${P}/adapters/agent-health.ts`, "Codex cli_missing is reported twice", "When the CLI is missing, runtimeIssuesUncached pushes cli_missing and then repeats the --version check, duplicating the issue."),
    ])
  );
  assert.equal(r.ok, true, r.problems?.join("\n"));
  assert.deepEqual(r.matched, ["duplicate-cli-missing"]);
});

test("muse-12 rejects approved results with no defect, broad vocabulary, wrong files and wrong SHAs", () => {
  assert.equal(gradeReview(t12, review("approved", [])).ok, false);
  const vocab = finding(`${P}/coordinator/commands.ts`, "recovery and lease handling", "recovery, work-items, lease, ceiling, dead-letter and cli_missing are all mentioned here.");
  assert.equal(gradeReview(t12, review("approved", [vocab])).ok, false);
  const rightFileBroad = finding(`${P}/coordinator/recovery.ts`, "Recovery looks fine", "recovery is fine, lease code is well-tested.");
  assert.equal(gradeReview(t12, review("changes_requested", [rightFileBroad])).ok, false);
  const good = finding(`${P}/coordinator/recovery.ts`, "Lease-expiry recovery ignores runtime availability", "A crash during a usage cap observation leaves an expired lease that recovery dead-letters instead of deferring; it never consults runtime_availability.");
  assert.equal(gradeReview(t12, review("changes_requested", [good], { baseSha: base, headSha: base })).ok, false);
  assert.equal(gradeReview(t12, review("changes_requested", [good])).ok, true);
});
