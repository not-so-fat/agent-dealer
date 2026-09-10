// packages/server/src/adapters/github.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrView } from "./github.js";

const FIXTURE = JSON.stringify({
  number: 142,
  url: "https://github.com/org/repo/pull/142",
  baseRefName: "main",
  headRefName: "issue-1",
  headRefOid: "a84f20cdeadbeef0000000000000000000000",
  reviews: [
    {
      author: { login: "reviewer-bot" },
      state: "CHANGES_REQUESTED",
      body: "Found 2 blocking issues",
      submittedAt: "2026-09-10T12:00:00Z",
    },
  ],
});

test("parsePrView extracts identity, head SHA, and normalized reviews", () => {
  const view = parsePrView(FIXTURE);
  assert.equal(view.number, 142);
  assert.equal(view.headRefOid, "a84f20cdeadbeef0000000000000000000000");
  assert.equal(view.baseRefName, "main");
  assert.equal(view.reviews.length, 1);
  assert.equal(view.reviews[0].author, "reviewer-bot");
  assert.equal(view.reviews[0].state, "CHANGES_REQUESTED");
});

test("parsePrView handles a PR with no reviews yet", () => {
  const view = parsePrView(JSON.stringify({ number: 1, url: "u", baseRefName: "main", headRefName: "b", headRefOid: "sha", reviews: [] }));
  assert.deepStrictEqual(view.reviews, []);
});

test("parsePrView throws on malformed JSON rather than silently returning a partial view", () => {
  assert.throws(() => parsePrView("not json"));
});
