import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveHumanActionOutcome,
  parseHumanResolution,
  gateRuntimeAuthParkResume,
  authProbeConfirmsFailure,
  remediationFromProbe,
  RUNTIME_AUTH_PARK_EVIDENCE_KEY,
  parseRuntimeAuthParkEvidence,
  type RuntimeAuthParkEvidence,
} from "./human-resolution.js";
import {
  BUILTIN_AGENT_CLAUDE_ID,
  BUILTIN_AGENT_CURSOR_ID,
  CURSOR_AUTH_REMEDIATION,
  CURSOR_KEYCHAIN_REMEDIATION,
  MUSE_AUTH_REMEDIATION,
} from "@agent-dealer/shared";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-human-res-"));

const { migrate, getDb } = await import("../db/index.js");
const { createIssue, getIssue, transitionIssue } = await import("../repository/issues.js");
const { listHumanActionsForIssue, getHumanAction } = await import("../repository/human-actions.js");
const { claimWorkItem, listWorkItemsForIssue, getWorkItem } = await import("../repository/work-items.js");
const { setRuntimeIssuesUncachedForTests } = await import("../adapters/agent-health.js");
const { stubManagedCloneForTests } = await import("../adapters/managed-repo.js");
const {
  startWorkflow,
  applyCompletion,
  resolveHumanActionAndAdvanceAsync,
} = await import("./commands.js");

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../shared/src/fixtures/runtime-auth"
);
const MUSE_AUTH_LOG = fs.readFileSync(path.join(FIXTURE_DIR, "muse-exec-missing-credentials.txt"), "utf8");

/** NOT-114 keychain has no capture file — same reconstruction as runtime-auth-health / routing tests. */
const CURSOR_KEYCHAIN_STDERR = `Cursor couldn't save your login to the macOS keychain (errSecDuplicateItem, security exit code 45).
The keychain item is stuck. Delete it and sign in again:
  security delete-generic-password -s cursor-access-token -a cursor-user
  agent login
`;

before(() => migrate());
beforeEach(() => {
  getDb().exec("DELETE FROM work_items");
  setRuntimeIssuesUncachedForTests(null);
  stubManagedCloneForTests("acme/app");
});

function newIssue(opts: { maxInfraAttempts?: number } = {}): string {
  return createIssue({
    title: "Auth park me",
    description: "d",
    acceptanceCriteria: "It works",
    repo: "acme/app",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: opts.maxInfraAttempts ?? 3,
    source: "manual",
  }).id;
}

function claim(issueId: string) {
  const item = claimWorkItem(`test-${issueId}`, { leaseMs: 60_000 });
  assert.ok(item && item.issueId === issueId, "expected to lease this issue's work item");
  return item!;
}

async function complete(issueId: string, outcome: Parameters<typeof applyCompletion>[2]) {
  const item = claim(issueId);
  return { item, result: await applyCompletion(item.id, item.leaseToken!, outcome) };
}

function openAuthPark(issueId: string) {
  return listHumanActionsForIssue(issueId).find(
    (a) => a.status === "open" && parseRuntimeAuthParkEvidence(a.evidenceJson) != null
  );
}

function stubProbeFailing(remediation = MUSE_AUTH_REMEDIATION) {
  setRuntimeIssuesUncachedForTests(async () => [{ code: "runtime_auth", message: remediation }]);
}

function stubProbePassing() {
  setRuntimeIssuesUncachedForTests(async () => []);
}

// Reviewer finding #8: an unrecognized choice must be rejected, not silently treated as "close".
test("parseHumanResolution rejects a choice not in that action type's allowed set", () => {
  assert.equal(parseHumanResolution("final_review", "bogus"), null);
  assert.equal(parseHumanResolution("attempts_exhausted", "complete"), null); // valid for final_review, not this type
});

test("parseHumanResolution rejects an unknown action type", () => {
  assert.equal(parseHumanResolution("not_a_real_action_type", "complete"), null);
});

test("parseHumanResolution accepts a valid (actionType, choice) pair", () => {
  assert.deepStrictEqual(parseHumanResolution("final_review", "repair"), { actionType: "final_review", choice: "repair" });
});

// PR #21 review finding #3: reflection_interaction_required has no HumanResolution variant
// — it must never parse successfully here even though VALID_CHOICES lists its choices (kept
// there only so that Record<HumanActionType, ...> stays total). Its only legal resolver is
// resolveReflectionInteractionAction (reflect-trigger.ts).
test("parseHumanResolution rejects reflection_interaction_required even though VALID_CHOICES lists its choices", () => {
  assert.equal(parseHumanResolution("reflection_interaction_required", "retry"), null);
  assert.equal(parseHumanResolution("reflection_interaction_required", "dismiss"), null);
});

test("resolveHumanActionOutcome throws rather than silently closing on an invalid choice reaching it directly", () => {
  assert.throws(() => resolveHumanActionOutcome({ actionType: "final_review", choice: "bogus" } as never), /Unrecognized final_review choice/);
});

test("final_review merge marks the issue done and triggers reflect", () => {
  const result = resolveHumanActionOutcome({ actionType: "final_review", choice: "merge" });
  assert.equal(result.issueStatus, "done");
  assert.equal(result.workflowOutcome, "done");
  assert.equal(result.triggerReflect, true);
});

test("final_review complete (legacy synonym) still marks done", () => {
  const result = resolveHumanActionOutcome({ actionType: "final_review", choice: "complete" });
  assert.equal(result.issueStatus, "done");
  assert.equal(result.workflowOutcome, "done");
  assert.equal(result.triggerReflect, true);
});

test("parseHumanResolution accepts merge for final_review", () => {
  assert.deepStrictEqual(parseHumanResolution("final_review", "merge"), {
    actionType: "final_review",
    choice: "merge",
  });
});

test("final_review repair sends the issue back for another round without reflect", () => {
  const result = resolveHumanActionOutcome({ actionType: "final_review", choice: "repair" });
  assert.equal(result.issueStatus, "repairing");
  assert.equal(result.startNewRound, true);
  assert.equal(result.triggerReflect, undefined);
});

test("final_review close closes the workflow without accepting the work", () => {
  const result = resolveHumanActionOutcome({ actionType: "final_review", choice: "close" });
  assert.equal(result.issueStatus, "closed");
  assert.equal(result.workflowOutcome, "closed");
  assert.equal(result.triggerReflect, undefined);
});

test("attempts_exhausted retry starts a new round (v1: equivalent to another repair round)", () => {
  const result = resolveHumanActionOutcome({ actionType: "attempts_exhausted", choice: "retry" });
  assert.equal(result.issueStatus, "repairing");
  assert.equal(result.startNewRound, true);
});

test("attempts_exhausted close ends the issue", () => {
  const result = resolveHumanActionOutcome({ actionType: "attempts_exhausted", choice: "close" });
  assert.equal(result.issueStatus, "closed");
});

test("policy_escalation resume continues development", () => {
  const result = resolveHumanActionOutcome({ actionType: "policy_escalation", choice: "resume" });
  assert.equal(result.issueStatus, "developing");
  assert.equal(result.startNewRound, true);
});

test("product_scope_decision resume continues development from the pre-start gate", () => {
  const result = resolveHumanActionOutcome({ actionType: "product_scope_decision", choice: "resume" });
  assert.equal(result.issueStatus, "developing");
});

test("deck_interaction_required resume starts a fresh infra round, not a review-round spend", () => {
  const result = resolveHumanActionOutcome({ actionType: "deck_interaction_required", choice: "resume" });
  assert.equal(result.issueStatus, "developing");
  assert.equal(result.startNewRound, true);
  assert.equal(result.roundKind, "infra");
});

test("deck_interaction_required close ends the issue", () => {
  const result = resolveHumanActionOutcome({ actionType: "deck_interaction_required", choice: "close" });
  assert.equal(result.issueStatus, "closed");
  assert.equal(result.workflowOutcome, "closed");
});

// NOT-314: operator_verification parses only with a non-empty note.
test("parseHumanResolution accepts operator_verification choices only with a note", () => {
  assert.deepStrictEqual(parseHumanResolution("operator_verification", "verified", "SSO login OK"), {
    actionType: "operator_verification",
    choice: "verified",
    note: "SSO login OK",
  });
  assert.deepStrictEqual(parseHumanResolution("operator_verification", "waive", "  waiver reason  "), {
    actionType: "operator_verification",
    choice: "waive",
    note: "waiver reason",
  });
  assert.deepStrictEqual(parseHumanResolution("operator_verification", "repair", "fix the probe"), {
    actionType: "operator_verification",
    choice: "repair",
    note: "fix the probe",
  });
  assert.equal(parseHumanResolution("operator_verification", "verified"), null);
  assert.equal(parseHumanResolution("operator_verification", "verified", ""), null);
  assert.equal(parseHumanResolution("operator_verification", "verified", "   "), null);
  assert.equal(parseHumanResolution("operator_verification", "merge", "a note"), null);
});

test("operator_verification repair queues another repair round; verified/waive never map here", () => {
  const result = resolveHumanActionOutcome({
    actionType: "operator_verification",
    choice: "repair",
    note: "fix the probe",
  });
  assert.equal(result.issueStatus, "repairing");
  assert.equal(result.startNewRound, true);
  assert.equal(result.roundKind, "review");
  assert.throws(
    () => resolveHumanActionOutcome({ actionType: "operator_verification", choice: "verified", note: "ok" }),
    /Unrecognized operator_verification choice/
  );
});

// --- NOT-368: resolve-time auth-park re-probe ---

const AUTH_PARK_EVIDENCE: RuntimeAuthParkEvidence = {
  runtime: "muse_code",
  remediation: MUSE_AUTH_REMEDIATION,
  rawCause: "missing meta credentials: run muse login or set META_API_KEY",
  consecutivePark: 1,
};

test("NOT-368: authProbeConfirmsFailure is true for runtime_auth and cursor_keychain only", () => {
  assert.equal(authProbeConfirmsFailure([{ code: "runtime_auth", message: MUSE_AUTH_REMEDIATION }]), true);
  assert.equal(
    authProbeConfirmsFailure([{ code: "cursor_keychain", message: "keychain stuck" }]),
    true
  );
  assert.equal(authProbeConfirmsFailure([{ code: "cli_missing", message: "install muse" }]), false);
  assert.equal(authProbeConfirmsFailure([]), false);
});

test("NOT-368: remediationFromProbe keeps keychain text when probe only reports runtime_auth", () => {
  assert.equal(
    remediationFromProbe(
      [{ code: "runtime_auth", message: CURSOR_AUTH_REMEDIATION }],
      CURSOR_KEYCHAIN_REMEDIATION
    ),
    CURSOR_KEYCHAIN_REMEDIATION
  );
  assert.equal(
    remediationFromProbe(
      [{ code: "cursor_keychain", message: CURSOR_KEYCHAIN_REMEDIATION }],
      "stale fallback"
    ),
    CURSOR_KEYCHAIN_REMEDIATION
  );
  assert.equal(
    remediationFromProbe(
      [{ code: "runtime_auth", message: "probe says login" }],
      MUSE_AUTH_REMEDIATION
    ),
    "probe says login"
  );
  assert.equal(remediationFromProbe([], CURSOR_KEYCHAIN_REMEDIATION), CURSOR_KEYCHAIN_REMEDIATION);
});

test("NOT-368: gate helper — still-failing probe refuses resume", () => {
  const gate = gateRuntimeAuthParkResume({
    evidence: AUTH_PARK_EVIDENCE,
    probeStillFailing: true,
    probeRemediation: MUSE_AUTH_REMEDIATION,
  });
  assert.equal(gate.proceed, false);
  if (!gate.proceed) {
    assert.match(gate.message, /still not authenticated/i);
    assert.match(gate.remediation, /muse login|META_API_KEY/i);
  }
});

test("NOT-368: gate helper — passing probe allows resume (infra roundKind, no charge)", () => {
  const gate = gateRuntimeAuthParkResume({
    evidence: AUTH_PARK_EVIDENCE,
    probeStillFailing: false,
  });
  assert.deepStrictEqual(gate, { proceed: true });
  const resume = resolveHumanActionOutcome({ actionType: "policy_escalation", choice: "resume" });
  assert.equal(resume.issueStatus, "developing");
  assert.equal(resume.startNewRound, true);
  assert.equal(resume.roundKind, "infra");
  assert.equal(RUNTIME_AUTH_PARK_EVIDENCE_KEY, "runtimeAuthPark");
});

// --- NOT-368: coordinator-level apply + resolve (probe stubbed) ---

test("NOT-368: confirmed auth park persists remediation, does not charge infraAttempts", async () => {
  stubProbeFailing();
  const issueId = newIssue();
  startWorkflow(issueId);
  transitionIssue(issueId, "developing", { branch: "issue-auth-salvage" });
  const infraBefore = getIssue(issueId)!.infraAttempts;

  const { result } = await complete(issueId, {
    kind: "session_failed",
    reason: MUSE_AUTH_LOG.trim().slice(0, 300),
  });
  assert.equal(result.applied, true);
  assert.equal(getIssue(issueId)!.status, "needs_human");
  assert.equal(getIssue(issueId)!.infraAttempts, infraBefore, "park must not charge infra");

  const action = openAuthPark(issueId);
  assert.ok(action, "expected open auth-park human action");
  assert.match(action!.reason, /muse login|META_API_KEY/i);
  const evidence = parseRuntimeAuthParkEvidence(action!.evidenceJson);
  assert.ok(evidence);
  assert.equal(evidence!.runtime, "muse_code");
  assert.match(evidence!.remediation, /muse login|META_API_KEY/i);
  assert.equal(listWorkItemsForIssue(issueId).filter((w) => w.status === "pending").length, 0);
});

test("NOT-368: keychain classification + runtime_auth probe keeps keychain remediation (park + resolve)", async () => {
  // Live status often confirms failure as ordinary runtime_auth; that must not replace
  // the classifier's keychain deletion instructions (park or Resume rewrite).
  setRuntimeIssuesUncachedForTests(async () => [
    { code: "runtime_auth", message: CURSOR_AUTH_REMEDIATION },
  ]);
  const issueId = newIssue();
  startWorkflow(issueId);
  const infraBefore = getIssue(issueId)!.infraAttempts;

  await complete(issueId, {
    kind: "session_failed",
    reason: CURSOR_KEYCHAIN_STDERR.trim().slice(0, 400),
  });
  assert.equal(getIssue(issueId)!.status, "needs_human");
  assert.equal(getIssue(issueId)!.infraAttempts, infraBefore);

  const action = openAuthPark(issueId);
  assert.ok(action, "expected open auth-park human action");
  assert.match(action!.reason, /delete-generic-password|errSecDuplicateItem/i);
  assert.doesNotMatch(action!.reason, /CURSOR_API_KEY/);
  const evidence = parseRuntimeAuthParkEvidence(action!.evidenceJson);
  assert.ok(evidence);
  assert.equal(evidence!.runtime, "cursor_local");
  assert.equal(evidence!.remediation, CURSOR_KEYCHAIN_REMEDIATION);

  const resolved = await resolveHumanActionAndAdvanceAsync(action!.id, "op", "resume");
  assert.equal(resolved.ok, false);
  assert.equal((resolved as { code: number }).code, 409);
  assert.match(
    (resolved as { error: string }).error,
    /delete-generic-password|errSecDuplicateItem/i
  );
  assert.doesNotMatch((resolved as { error: string }).error, /CURSOR_API_KEY/);
  assert.match(getHumanAction(action!.id)!.reason, /delete-generic-password|errSecDuplicateItem/i);
  assert.equal(getHumanAction(action!.id)!.status, "open");
});

test("NOT-368: resolve with still-failing probe keeps action open and spawns nothing", async () => {
  stubProbeFailing();
  const issueId = newIssue();
  startWorkflow(issueId);
  await complete(issueId, {
    kind: "session_failed",
    reason: MUSE_AUTH_LOG.trim().slice(0, 300),
  });
  const action = openAuthPark(issueId)!;
  const pendingBefore = listWorkItemsForIssue(issueId).filter((w) => w.status === "pending").length;
  const infraBefore = getIssue(issueId)!.infraAttempts;

  const resolved = await resolveHumanActionAndAdvanceAsync(action.id, "op", "resume");
  assert.equal(resolved.ok, false);
  assert.equal((resolved as { code: number }).code, 409);
  assert.match((resolved as { error: string }).error, /still not authenticated/i);

  assert.equal(getHumanAction(action.id)!.status, "open");
  assert.equal(getIssue(issueId)!.status, "needs_human");
  assert.equal(getIssue(issueId)!.infraAttempts, infraBefore);
  assert.equal(
    listWorkItemsForIssue(issueId).filter((w) => w.status === "pending").length,
    pendingBefore
  );
});

test("NOT-368: resolve with passing probe re-queues developer on salvaged branch with no infra charge", async () => {
  stubProbeFailing();
  const issueId = newIssue();
  startWorkflow(issueId);
  const salvageBranch = "issue-auth-salvage-resume";
  transitionIssue(issueId, "developing", { branch: salvageBranch });
  await complete(issueId, {
    kind: "session_failed",
    reason: MUSE_AUTH_LOG.trim().slice(0, 300),
  });
  const action = openAuthPark(issueId)!;
  const roundBefore = getIssue(issueId)!.currentRound;
  const infraAtPark = getIssue(issueId)!.infraAttempts;

  stubProbePassing();
  const resolved = await resolveHumanActionAndAdvanceAsync(action.id, "op", "resume");
  assert.equal(resolved.ok, true);
  assert.equal(getHumanAction(action.id)!.status, "resolved");
  assert.equal(getIssue(issueId)!.status, "developing");
  assert.equal(getIssue(issueId)!.branch, salvageBranch);
  assert.equal(getIssue(issueId)!.currentRound, roundBefore, "resume must not spend a review round");
  // Infra resume resets the counter (NOT-93) — it must not land above the park-time value
  // via a charge, and typically returns to 0.
  assert.ok(getIssue(issueId)!.infraAttempts <= infraAtPark);

  const pending = listWorkItemsForIssue(issueId).filter(
    (w) => w.status === "pending" && w.kind === "developer"
  );
  assert.equal(pending.length, 1);
  assert.equal(getWorkItem(pending[0]!.id)!.kind, "developer");
});

test("NOT-368: probe-passing auth failure charges infra by exactly 1; second parks even when probe passes", async () => {
  stubProbePassing();
  const issueId = newIssue();
  startWorkflow(issueId);
  assert.equal(getIssue(issueId)!.infraAttempts, 0);

  await complete(issueId, {
    kind: "session_failed",
    reason: MUSE_AUTH_LOG.trim().slice(0, 300),
  });
  assert.equal(getIssue(issueId)!.infraAttempts, 1, "transient auth retry charges exactly +1");
  assert.equal(getIssue(issueId)!.status, "developing");
  const retry = listWorkItemsForIssue(issueId).find((w) => w.status === "pending" && w.kind === "developer");
  assert.ok(retry);
  const payload = JSON.parse(retry!.payloadJson!) as { authTransientRetry?: boolean };
  assert.equal(payload.authTransientRetry, true);

  // Second high-confidence auth failure parks even though the probe still passes.
  await complete(issueId, {
    kind: "session_failed",
    reason: MUSE_AUTH_LOG.trim().slice(0, 300),
  });
  assert.equal(getIssue(issueId)!.status, "needs_human");
  assert.equal(getIssue(issueId)!.infraAttempts, 1, "park after transient retry must not charge again");
  assert.ok(openAuthPark(issueId));
});

test("NOT-368: four consecutive confirmed auth parks escalate on the 4th (persisted streak)", async () => {
  const issueId = newIssue({ maxInfraAttempts: 5 });
  startWorkflow(issueId);

  for (let park = 1; park <= 3; park++) {
    stubProbeFailing();
    await complete(issueId, {
      kind: "session_failed",
      reason: MUSE_AUTH_LOG.trim().slice(0, 300),
    });
    const action = openAuthPark(issueId);
    assert.ok(action, `expected auth park #${park}`);
    const evidence = parseRuntimeAuthParkEvidence(action!.evidenceJson);
    assert.equal(evidence!.consecutivePark, park);
    assert.equal(getIssue(issueId)!.infraAttempts, 0);

    stubProbePassing();
    const resolved = await resolveHumanActionAndAdvanceAsync(action!.id, "op", "resume");
    assert.equal(resolved.ok, true, `resume after park #${park}`);
  }

  stubProbeFailing();
  await complete(issueId, {
    kind: "session_failed",
    reason: MUSE_AUTH_LOG.trim().slice(0, 300),
  });
  assert.equal(getIssue(issueId)!.status, "needs_human");
  assert.equal(getIssue(issueId)!.infraAttempts, 0);
  const fourth = listHumanActionsForIssue(issueId).find((a) => a.status === "open");
  assert.ok(fourth);
  assert.match(fourth!.reason, /Repeated .* login failures/i);
  assert.equal(
    parseRuntimeAuthParkEvidence(fourth!.evidenceJson),
    null,
    "4th outcome is a distinct escalation, not another auth park"
  );
});

test("NOT-368: reviewer session_failed with confirmed auth parks (resumeAsReviewer + evidence)", async () => {
  stubProbeFailing();
  const issueId = newIssue();
  startWorkflow(issueId);
  await complete(issueId, {
    kind: "clean_handoff",
    branch: "issue-reviewer-auth",
    headSha: "abc123",
    baseSha: "base1",
    prNumber: 42,
    prUrl: "https://gh/pr/42",
  });
  assert.equal(getIssue(issueId)!.status, "reviewing");
  const infraBefore = getIssue(issueId)!.infraAttempts;

  await complete(issueId, {
    kind: "session_failed",
    reason: MUSE_AUTH_LOG.trim().slice(0, 300),
  });
  assert.equal(getIssue(issueId)!.status, "needs_human");
  assert.equal(getIssue(issueId)!.infraAttempts, infraBefore);

  const action = openAuthPark(issueId);
  assert.ok(action, "reviewer auth failure must park with runtimeAuthPark evidence");
  assert.match(action!.reason, /muse login|META_API_KEY/i);
  const preview = JSON.parse(action!.continuationPreviewJson!) as {
    resumeRole?: string;
    resumeHeadSha?: string;
  };
  assert.equal(preview.resumeRole, "reviewer");
  assert.equal(preview.resumeHeadSha, "abc123");

  stubProbePassing();
  const resolved = await resolveHumanActionAndAdvanceAsync(action!.id, "op", "resume");
  assert.equal(resolved.ok, true);
  assert.equal(getIssue(issueId)!.status, "reviewing");
  const pending = listWorkItemsForIssue(issueId).filter(
    (w) => w.status === "pending" && w.kind === "reviewer"
  );
  assert.equal(pending.length, 1);
});
