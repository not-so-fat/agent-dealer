import { test } from "node:test";
import assert from "node:assert/strict";
import { Finding } from "./findings.js";

test("Finding schema parses an open finding", () => {
  const finding: Finding = {
    id: "88888888-8888-8888-8888-888888888888",
    issueId: "11111111-1111-1111-1111-111111111111",
    fingerprint: "missing-null-check-auth-ts-42",
    severity: "blocking",
    title: "Missing null check",
    rationale: "user can be undefined here",
    evidenceRef: "https://github.com/org/repo/pull/1#discussion_r1",
    file: "src/auth.ts",
    line: 42,
    status: "open",
    firstRound: 1,
    lastRound: 1,
  };
  assert.deepStrictEqual(Finding.parse(finding), finding);
});
