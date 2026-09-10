import { test } from "node:test";
import assert from "node:assert/strict";
import { computeIntentForecast } from "./intent-forecast.js";
import type { Issue } from "@agent-dealer/shared";

const BASE: Issue = {
  id: "i1", source: "manual", externalId: null, externalLabel: null, externalUrl: null,
  title: "T", description: null, acceptanceCriteria: null, repo: "/r", baseBranch: "main",
  status: "ready", currentOwner: "system", currentIntent: null,
  developerAgentId: null, reviewerAgentId: null, maxReviewRounds: 3, currentRound: 1,
  branch: null, baseSha: null, headSha: null, prNumber: null, prUrl: null,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};

test("ready issue forecasts starting the developer round", () => {
  const forecast = computeIntentForecast(BASE);
  assert.match(forecast.now, /Ready/i);
  assert.match(forecast.next, /developer/i);
});

test("developing issue forecasts handoff verification", () => {
  const forecast = computeIntentForecast({ ...BASE, status: "developing", currentOwner: "developer" });
  assert.match(forecast.now, /Developer/i);
  assert.match(forecast.next, /verify|handoff|pr/i);
});

test("reviewing issue mentions the round number", () => {
  const forecast = computeIntentForecast({ ...BASE, status: "reviewing", currentOwner: "reviewer", currentRound: 2 });
  assert.match(forecast.now, /Reviewer/i);
  assert.ok(forecast.now.includes("2") || forecast.next.includes("2"));
});

test("needs_human issue forecasts waiting on a decision", () => {
  const forecast = computeIntentForecast({ ...BASE, status: "needs_human", currentOwner: "human" });
  assert.match(forecast.now, /human|action/i);
});

test("done issue has no next step", () => {
  const forecast = computeIntentForecast({ ...BASE, status: "done" });
  assert.equal(forecast.next, "");
});
