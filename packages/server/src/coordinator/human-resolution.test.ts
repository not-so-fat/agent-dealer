import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveHumanActionOutcome,
  parseHumanResolution,
  gateRuntimeAuthParkResume,
  authProbeConfirmsFailure,
  RUNTIME_AUTH_PARK_EVIDENCE_KEY,
  type RuntimeAuthParkEvidence,
} from "./human-resolution.js";
import { MUSE_AUTH_REMEDIATION } from "@agent-dealer/shared";

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

test("NOT-368: still-failing resolve probe keeps the action open (no spawn)", () => {
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

test("NOT-368: passing resolve probe allows resume — same infra roundKind as deck_interaction (no charge)", () => {
  const gate = gateRuntimeAuthParkResume({
    evidence: AUTH_PARK_EVIDENCE,
    probeStillFailing: false,
  });
  assert.deepStrictEqual(gate, { proceed: true });
  // Resume of a policy_escalation (auth park) reuses the NOT-93 park path: startNewRound
  // with roundKind "infra" resets budgets but does not increment them — no round / infra charge.
  const resume = resolveHumanActionOutcome({ actionType: "policy_escalation", choice: "resume" });
  assert.equal(resume.issueStatus, "developing");
  assert.equal(resume.startNewRound, true);
  assert.equal(resume.roundKind, "infra");
  assert.equal(RUNTIME_AUTH_PARK_EVIDENCE_KEY, "runtimeAuthPark");
});
