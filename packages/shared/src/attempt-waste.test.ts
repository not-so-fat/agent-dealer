// packages/shared/src/attempt-waste.test.ts
//
// NOT-172: checkpoint/reuse shared contract — closed kind vocabularies and
// payload shapes that coordinator evidence and derivation agree on.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CheckpointKind,
  CheckpointObservedPayload,
  CheckpointOrigin,
  RetryReusedPayload,
  RetryReuseKind,
} from "./attempt-waste.js";

test("CheckpointKind accepts exactly commit, verification_receipt, branch_pushed", () => {
  assert.equal(CheckpointKind.parse("commit"), "commit");
  assert.equal(CheckpointKind.parse("verification_receipt"), "verification_receipt");
  assert.equal(CheckpointKind.parse("branch_pushed"), "branch_pushed");
  assert.throws(() => CheckpointKind.parse("push"));
  assert.throws(() => CheckpointKind.parse("salvage"));
});

test("CheckpointOrigin distinguishes sampler, salvage, session_end commits", () => {
  assert.equal(CheckpointOrigin.parse("sampler"), "sampler");
  assert.equal(CheckpointOrigin.parse("salvage"), "salvage");
  assert.equal(CheckpointOrigin.parse("session_end"), "session_end");
  assert.throws(() => CheckpointOrigin.parse("commit"));
});

test("RetryReuseKind accepts worktree, commit, verification_receipt, publish_only", () => {
  assert.equal(RetryReuseKind.parse("worktree"), "worktree");
  assert.equal(RetryReuseKind.parse("commit"), "commit");
  assert.equal(RetryReuseKind.parse("verification_receipt"), "verification_receipt");
  assert.equal(RetryReuseKind.parse("publish_only"), "publish_only");
  assert.throws(() => RetryReuseKind.parse("cold"));
});

test("CheckpointObservedPayload parses a sampler commit with precision", () => {
  const payload = {
    kind: "commit",
    observedSha: "a".repeat(40),
    observedAt: "2026-09-21T00:00:01.000Z",
    origin: "sampler",
    inputSha: "b".repeat(40),
    samplingPrecisionMs: 10_000,
    branch: "issue-1",
  };
  assert.deepEqual(CheckpointObservedPayload.parse(payload), payload);
});

test("RetryReusedPayload parses a cold retry as empty kinds, not absent", () => {
  const payload = { kinds: [], retryReason: "Developer session produced no PR." };
  assert.deepEqual(RetryReusedPayload.parse(payload), payload);
  assert.deepEqual(RetryReusedPayload.parse({ kinds: ["publish_only"], retryReason: null }), {
    kinds: ["publish_only"],
    retryReason: null,
  });
});
