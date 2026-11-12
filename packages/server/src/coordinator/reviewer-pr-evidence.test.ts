// NOT-575: the reviewer can see PR-body evidence and recorded operator
// attestations — the sandbox has no network/`gh`, so both arrive via the
// prompt. Covers the PR-body path and the attestation path.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not575-rev-"));

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("../repository/issues.js");
const { createIssueArtifact } = await import("../repository/artifacts.js");
const { appendWorkflowEvent } = await import("../repository/workflow-events.js");
const { listOperatorAttestations } = await import("./operator-criteria.js");
const {
  buildReviewerPrompt,
  operatorAttestationsSection,
  prBodyEvidenceSection,
  PR_BODY_EVIDENCE_MAX_CHARS,
  OPERATOR_ATTESTATION_NOTE_MAX_CHARS,
  OPERATOR_ATTESTATIONS_MAX_COUNT,
} = await import("./prompts.js");
const { readPrBodyForReview } = await import("./reviewer-effect.js");
const { createGithubAdapter, parsePrBody } = await import("../adapters/github.js");

before(() => migrate());
beforeEach(() => {
  getDb().exec(`
    DELETE FROM work_items;
    DELETE FROM human_actions;
    DELETE FROM workflow_events;
    DELETE FROM worker_sessions;
    DELETE FROM artifacts;
    DELETE FROM workflow_instances;
    DELETE FROM issues;
  `);
});

const taskSnapshot = {
  title: "Add widget",
  description: "Build the widget.",
  acceptanceCriteria: "Widget renders.",
  repo: "acme/app",
  baseBranch: "main",
};
const reviewerBase = {
  taskSnapshot,
  round: 1,
  baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  diff: "diff --git a/x b/x\n+added line\n",
};

test("PR-body path: the prompt embeds the live body and never escalates for living there", () => {
  const withBody = buildReviewerPrompt({
    ...reviewerBase,
    prBody: "Implementation conclusion.\n\nProbe output:\n```\nSSO login OK — dashboard shown\n```",
  });
  assert.match(withBody, /## PR body \(live — evidence pasted there counts\)/);
  assert.match(withBody, /SSO login OK — dashboard shown/);
  assert.match(withBody, /never escalate only because it lives here instead of in the diff/);
});

test("PR-body path: absent or blank bodies render nothing (byte-for-byte)", () => {
  const without = buildReviewerPrompt(reviewerBase);
  assert.doesNotMatch(without, /## PR body/);
  assert.equal(buildReviewerPrompt({ ...reviewerBase, prBody: undefined }), without);
  assert.equal(buildReviewerPrompt({ ...reviewerBase, prBody: null }), without);
  assert.equal(buildReviewerPrompt({ ...reviewerBase, prBody: "   \n  " }), without);
  assert.deepEqual(prBodyEvidenceSection(undefined), []);
  assert.deepEqual(prBodyEvidenceSection("  "), []);
});

test("PR-body path: long bodies cap with an explicit truncation marker", () => {
  const body = `start-${"x".repeat(PR_BODY_EVIDENCE_MAX_CHARS + 500)}`;
  const section = prBodyEvidenceSection(body).join("\n");
  assert.match(section, /start-xxx/);
  assert.match(section, new RegExp(`PR body truncated to ${PR_BODY_EVIDENCE_MAX_CHARS} characters`));
  assert.ok(section.length < body.length + 1000);
});

test("attestation path: verified and waived results render with heads, criteria, and notes", () => {
  const section = operatorAttestationsSection(
    [
      {
        kind: "verified",
        headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        note: "SSO login OK — dashboard shown.",
        by: "op",
        at: "2026-11-01T00:00:00.000Z",
        criteria: ["Operator signs in with SSO [operator]"],
      },
      {
        kind: "waived",
        headSha: "cccccccccccccccccccccccccccccccccccccccc",
        note: "Staging down; shipping behind the flag.",
        by: "op2",
        at: null,
        criteria: [],
      },
    ],
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  ).join("\n");
  assert.match(section, /## Operator attestations \(recorded results count as evidence\)/);
  assert.match(section, /never escalate for evidence an attestation below already provides/);
  assert.match(section, /### Verified \(this head by op at 2026-11-01T00:00:00\.000Z\)/);
  assert.match(section, /- Criterion: Operator signs in with SSO \[operator\]/);
  assert.match(section, /SSO login OK — dashboard shown/);
  assert.match(section, /### Waived \(head `cccccccc` by op2\)/);
  assert.match(section, /Staging down; shipping behind the flag/);
});

test("attestation path: empty renders nothing; notes and count cap with markers", () => {
  assert.deepEqual(operatorAttestationsSection(undefined, reviewerBase.headSha), []);
  assert.deepEqual(operatorAttestationsSection([], reviewerBase.headSha), []);
  const without = buildReviewerPrompt(reviewerBase);
  assert.doesNotMatch(without, /## Operator attestations/);
  assert.equal(buildReviewerPrompt({ ...reviewerBase, operatorAttestations: [] }), without);

  const long = operatorAttestationsSection(
    [
      {
        kind: "verified",
        headSha: reviewerBase.headSha,
        note: `n-${"y".repeat(OPERATOR_ATTESTATION_NOTE_MAX_CHARS + 100)}`,
        by: null,
        at: null,
        criteria: [],
      },
    ],
    reviewerBase.headSha
  ).join("\n");
  assert.match(long, new RegExp(`attestation note truncated to ${OPERATOR_ATTESTATION_NOTE_MAX_CHARS} characters`));

  const many = Array.from({ length: OPERATOR_ATTESTATIONS_MAX_COUNT + 2 }, (_, i) => ({
    kind: "verified" as const,
    headSha: reviewerBase.headSha,
    note: `note-${i}`,
    by: null,
    at: null,
    criteria: [] as string[],
  }));
  const capped = operatorAttestationsSection(many, reviewerBase.headSha).join("\n");
  assert.match(capped, /2 older attestation\(s\) omitted/);
  assert.match(capped, /note-6/);
  assert.doesNotMatch(capped, /note-0/);
});

test("attestation path: the prompt carries both evidence sections together", () => {
  const both = buildReviewerPrompt({
    ...reviewerBase,
    prBody: "PR body with the probe command.",
    operatorAttestations: [
      {
        kind: "verified",
        headSha: reviewerBase.headSha,
        note: "SSO login OK.",
        by: "op",
        at: null,
        criteria: ["Operator signs in with SSO [operator]"],
      },
    ],
  });
  assert.match(both, /## PR body \(live/);
  assert.match(both, /PR body with the probe command/);
  assert.match(both, /## Operator attestations/);
  assert.match(both, /SSO login OK/);
});

function newIssueId(): string {
  return createIssue({
    title: "Widget",
    description: "d",
    acceptanceCriteria: "Widget renders.",
    repo: "acme/app",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
    autoMerge: true,
  }).id;
}

test("listOperatorAttestations reads verified artifacts and waiver events, oldest first", () => {
  const issueId = newIssueId();
  assert.deepEqual(listOperatorAttestations(issueId), []);

  createIssueArtifact({
    issueId,
    kind: "operator_verification",
    author: "human",
    content: {
      headSha: "aaa",
      note: "SSO login OK.",
      verifiedBy: "op",
      verifiedAt: "2026-11-01T00:00:00.000Z",
      criteria: ["Operator signs in with SSO [operator]"],
    },
  });
  appendWorkflowEvent({
    issueId,
    type: "operator_verification.waived",
    actorType: "human",
    actorRef: "op2",
    stage: "needs_human",
    round: 1,
    payload: {
      actionType: "operator_verification",
      choice: "waive",
      headSha: "bbb",
      waivedBy: "op2",
      note: "Staging down.",
      criteria: ["Operator completes a paid checkout [operator]"],
    },
  });

  const attestations = listOperatorAttestations(issueId);
  assert.equal(attestations.length, 2);
  assert.deepEqual(attestations[0], {
    kind: "verified",
    headSha: "aaa",
    note: "SSO login OK.",
    by: "op",
    at: "2026-11-01T00:00:00.000Z",
    criteria: ["Operator signs in with SSO [operator]"],
  });
  assert.equal(attestations[1]!.kind, "waived");
  assert.equal(attestations[1]!.headSha, "bbb");
  assert.equal(attestations[1]!.note, "Staging down.");
  assert.equal(attestations[1]!.by, "op2");
  assert.deepEqual(attestations[1]!.criteria, ["Operator completes a paid checkout [operator]"]);
});

test("listOperatorAttestations skips unreadable rows instead of throwing", () => {
  const issueId = newIssueId();
  getDb()
    .prepare(
      "INSERT INTO artifacts (id, issue_id, kind, content_json, author, created_at) VALUES (?, ?, 'operator_verification', 'not json', 'human', ?)"
    )
    .run(crypto.randomUUID(), issueId, new Date().toISOString());
  assert.deepEqual(listOperatorAttestations(issueId), []);
});

test("readPrBodyForReview returns the body, null without a PR, a read, or on failure", async () => {
  const withBody = { prBody: async () => "live body" };
  assert.equal(await readPrBodyForReview(withBody as never, "/wt", 42), "live body");
  assert.equal(await readPrBodyForReview(withBody as never, "/wt", null), null);
  assert.equal(await readPrBodyForReview({} as never, "/wt", 42), null);
  const failing = {
    prBody: async () => {
      throw new Error("gh down");
    },
  };
  assert.equal(await readPrBodyForReview(failing as never, "/wt", 42), null);
});

test("parsePrBody keeps the body text, null when absent or blank", () => {
  assert.equal(parsePrBody("hello"), "hello");
  assert.equal(parsePrBody("  padded  "), "  padded  ");
  assert.equal(parsePrBody(""), null);
  assert.equal(parsePrBody("   "), null);
  assert.equal(parsePrBody(null), null);
  assert.equal(parsePrBody(undefined), null);
  assert.equal(parsePrBody(42), null);
});

test("the real adapter reads the PR body with an explicit-number gh pr view", async () => {
  const seen: Array<{ args: string[]; cwd: string }> = [];
  const adapter = createGithubAdapter(async (args, opts) => {
    seen.push({ args, cwd: opts.cwd });
    return { stdout: JSON.stringify({ body: "the live body" }) };
  });
  assert.equal(await adapter.prBody!({ cwd: "/repo", number: 42 }), "the live body");
  assert.deepEqual(seen, [{ args: ["pr", "view", "42", "--json", "body"], cwd: "/repo" }]);
});
