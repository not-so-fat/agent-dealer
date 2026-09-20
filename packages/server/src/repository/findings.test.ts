import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-findings-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("./issues.js");
const { reconcileFinding, resolveFinding, resolveFindingsAbsentFromRound, listFindingsForIssue } = await import("./findings.js");

before(() => {
  migrate();
});

function seedIssue(title: string): string {
  return createIssue({
    title,
    repo: "acme/app",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual"}).id;
}

test("creates a new finding as open", () => {
  const issueId = seedIssue("Finding issue 1");
  const finding = reconcileFinding({
    issueId,
    fingerprint: "fp-1",
    severity: "blocking",
    title: "Missing null check",
    rationale: "user can be undefined",
    round: 1});
  assert.equal(finding.status, "open");
  assert.equal(finding.firstRound, 1);
  assert.equal(finding.lastRound, 1);
});

test("marks a repeated fingerprint as recurring and bumps last_round", () => {
  const issueId = seedIssue("Finding issue 2");
  reconcileFinding({ issueId, fingerprint: "fp-1", severity: "blocking", title: "T", rationale: "R", round: 1 });
  const again = reconcileFinding({
    issueId,
    fingerprint: "fp-1",
    severity: "blocking",
    title: "T",
    rationale: "R",
    round: 2});
  assert.equal(again.status, "recurring");
  assert.equal(again.firstRound, 1);
  assert.equal(again.lastRound, 2);
});

test("resolves a finding", () => {
  const issueId = seedIssue("Finding issue 3");
  const finding = reconcileFinding({
    issueId,
    fingerprint: "fp-1",
    severity: "blocking",
    title: "T",
    rationale: "R",
    round: 1});
  const resolved = resolveFinding(finding.id);
  assert.equal(resolved.status, "resolved");
  assert.equal(listFindingsForIssue(issueId).find((f) => f.id === finding.id)?.status, "resolved");
});

test("resolveFindingsAbsentFromRound resolves only open/recurring findings of that issue missing from the round", () => {
  const issueId = seedIssue("Finding issue 4");
  const otherId = seedIssue("Finding issue 5");
  const base = { severity: "blocking" as const, title: "T", rationale: "R" };
  reconcileFinding({ ...base, issueId, fingerprint: "gone", round: 1 });
  reconcileFinding({ ...base, issueId, fingerprint: "kept", round: 1 });
  reconcileFinding({ ...base, issueId, fingerprint: "kept", round: 2 });
  reconcileFinding({ ...base, issueId: otherId, fingerprint: "gone", round: 1 });

  const resolved = resolveFindingsAbsentFromRound(issueId, ["kept"]);
  assert.deepEqual(resolved.map((f) => f.fingerprint), ["gone"]);
  const byFp = Object.fromEntries(listFindingsForIssue(issueId).map((f) => [f.fingerprint, f.status]));
  assert.deepEqual(byFp, { gone: "resolved", kept: "recurring" });
  assert.equal(listFindingsForIssue(otherId)[0].status, "open");

  assert.equal(resolveFindingsAbsentFromRound(issueId, []).length, 1, "an empty round resolves the remaining open findings");
  assert.equal(resolveFindingsAbsentFromRound(issueId, []).length, 0, "already-resolved findings are not touched again");
});
