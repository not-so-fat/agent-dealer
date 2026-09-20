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
  cursor: { deniesOutboundMutation: false, forceRequiredHeadless: true, denyListScope: "user-global" },
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

test("muse-10 rejects sources that deny each requested field (prose around the identifier)", () => {
  const a = usageAnswer();
  a.sources = { tokensIn: "not usage.input_tokens", tokensOut: "not usage.output_tokens", costUsd: "not total_cost_usd" };
  const r = gradeAnswer(task("muse-10-explore-usage-capture"), fence(a));
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 3, r.problems.join("\n"));
  for (const wrapped of ["usage.input_tokens is wrong", "usage.input_tokens or output_tokens", "input_tokens, not output_tokens"]) {
    const b = usageAnswer();
    b.sources.tokensIn = wrapped;
    assert.equal(gradeAnswer(task("muse-10-explore-usage-capture"), fence(b)).ok, false, wrapped);
  }
  const alias = usageAnswer();
  alias.sources = { tokensIn: "`input_tokens`", tokensOut: "usage.outputTokens", costUsd: "total_cost_usd" };
  assert.equal(gradeAnswer(task("muse-10-explore-usage-capture"), fence(alias)).ok, true);
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
  bad.cursor.forceRequiredHeadless = false;
  bad.cursor.denyListScope = "per-invocation";
  bad.claude.permissionMode = "bypassPermissions";
  assert.equal(gradeAnswer(task("muse-11-explore-reviewer-read-only"), fence(bad)).ok, false);
});

const base = "86d9cc644d53830f0457b6b3e8437be13c9cd30a";
const head = "9dda237c316f22d2b2c112048be7a1d1fe9c99f1";
const review = (verdict, findings, shas = { baseSha: base, headSha: head }) =>
  fence({ verdict, ...shas, acceptanceCriteriaAssessment: "ok", evidenceAssessment: "ok", findings, risks: [] });
const claimFinding = (id, file, title = "t", rationale = "r") => ({ fingerprint: `claim:${id}`, severity: "blocking", title, rationale, file, line: 1 });
const t12 = task("muse-12-review-usage-cap-deferral");
const HEALTH = `${P}/adapters/agent-health.ts`;
const REC = `${P}/coordinator/recovery.ts`;
const CEIL = `${P}/coordinator/usage-cap-defer.ts`;
const dup = () => claimFinding("duplicate-cli-missing", HEALTH);
const rec = () => claimFinding("recovery-ignores-runtime-availability", REC);
const ceil = () => claimFinding("untested-deferral-ceiling", CEIL);

test("muse-12 accepts two true claims and reports which matched", () => {
  const r = gradeReview(t12, review("changes_requested", [dup(), rec()]));
  assert.equal(r.ok, true, r.problems?.join("\n"));
  assert.deepEqual(r.matched, ["duplicate-cli-missing", "recovery-ignores-runtime-availability"]);
  assert.equal(gradeReview(t12, review("changes_requested", [dup(), rec(), ceil()])).matched.length, 3);
});

test("muse-12 rejects approved results, too few claims, wrong files, wrong SHAs, and unstructured findings", () => {
  assert.equal(gradeReview(t12, review("approved", [])).ok, false);
  assert.equal(gradeReview(t12, review("approved", [dup(), rec(), ceil()])).ok, false, "approved verdict with defects asserted");
  assert.equal(gradeReview(t12, review("escalated", [dup(), rec()])).ok, false);
  assert.equal(gradeReview(t12, review("changes_requested", [dup()])).ok, false, "only one true claim, need 2");
  assert.equal(gradeReview(t12, review("changes_requested", [dup(), dup()])).ok, false, "same claim twice is one claim");
  assert.equal(gradeReview(t12, review("changes_requested", [dup(), claimFinding("recovery-ignores-runtime-availability", `${P}/coordinator/commands.ts`)])).ok, false);
  assert.equal(gradeReview(t12, review("changes_requested", [dup(), rec()], { baseSha: base, headSha: base })).ok, false);
  const prose = (file, title, rationale) => ({ fingerprint: "f", severity: "blocking", title, rationale, file, line: 1 });
  const freeText = [
    prose(HEALTH, "cli_missing is reported twice", "runtimeIssuesUncached pushes cli_missing twice, duplicating the issue."),
    prose(REC, "recovery ignores runtime availability", "recovery never consults runtime_availability and dead-letters instead of deferring."),
  ];
  assert.equal(gradeReview(t12, review("changes_requested", freeText)).ok, false, "prose alone earns no credit");
});

test("muse-12 rejects natural-language denials, because the fingerprint alone carries the assertion and prose is not graded", () => {
  // Every case from the review findings: correct behavior, negated defects, refuted claims. None of these
  // texts can earn credit because credit requires a `claim:<id>` fingerprint, which asserts the claim.
  const denials = [
    [REC, "Lease expiry recovery consults runtime availability", "recovery defers the item instead of dead-lettering it."],
    [REC, "The claim that lease recovery ignores runtime availability is false", "It is inaccurate that the code never consults runtime_availability."],
    [CEIL, "The 24 h deferral ceiling is not untested", "There is no missing test."],
    [HEALTH, "cli_missing is reported once", "There is no duplicate."],
  ];
  for (const [file, title, rationale] of denials) {
    const f = { fingerprint: "recovery-consults", severity: "non_blocking", title, rationale, file, line: 1 };
    for (const verdict of ["approved", "changes_requested"]) {
      assert.equal(gradeReview(t12, review(verdict, [f])).ok, false, `${verdict}: ${title}`);
    }
  }
  // A reviewer who refutes a claim by omitting it, and asserts the true ones, passes.
  assert.equal(gradeReview(t12, review("changes_requested", [dup(), ceil()])).ok, true);
});

test("muse-12 rejects asserting a false decoy claim or an unknown claim id, even alongside true claims", () => {
  const decoys = [
    claimFinding("attempt-count-not-reverted", CEIL),
    claimFinding("capped-session-marked-failed", `${P}/coordinator/worker-loop.ts`),
    claimFinding("stale-cap-health-cache", HEALTH),
  ];
  for (const d of decoys) {
    const r = gradeReview(t12, review("changes_requested", [dup(), rec(), ceil(), d]));
    assert.equal(r.ok, false, d.fingerprint);
    assert.ok(r.problems.some((p) => p.startsWith("asserted false claim")), r.problems.join("\n"));
  }
  assert.equal(gradeReview(t12, review("changes_requested", [dup(), rec(), claimFinding("made-up", HEALTH)])).ok, false);
  // Asserting every claim in the catalogue (a guess-them-all strategy) fails on the decoys.
  assert.equal(gradeReview(t12, review("changes_requested", [dup(), rec(), ceil(), ...decoys])).ok, false);
});

test("muse-12 accepts findings with non-claim fingerprints next to valid claims", () => {
  const extra = { fingerprint: "style-nit", severity: "non_blocking", title: "naming", rationale: "prose", file: HEALTH, line: 3 };
  assert.equal(gradeReview(t12, review("changes_requested", [dup(), rec(), extra])).ok, true);
});

test("muse-12 rejects artifacts that do not parse as a ReviewerResult (every declared field is validated)", () => {
  const good = { verdict: "changes_requested", baseSha: base, headSha: head, acceptanceCriteriaAssessment: "ok", evidenceAssessment: "ok", findings: [dup(), rec()], risks: [] };
  assert.equal(gradeReview(t12, fence({ ...good, productScopeQuestion: "Which runtimes?" })).ok, true);
  const bad = [
    { ...good, productScopeQuestion: 123 },
    { ...good, productScopeQuestion: null },
    { ...good, risks: [1] },
    { ...good, findings: [null, dup(), rec()] },
    { ...good, findings: [{ ...dup(), line: 1.5 }, rec()] },
    { ...good, findings: [{ ...dup(), file: 7 }, rec()] },
    { ...good, acceptanceCriteriaAssessment: 1 },
  ];
  for (const b of bad) assert.equal(gradeReview(t12, fence(b)).ok, false, JSON.stringify(b).slice(0, 120));
});
