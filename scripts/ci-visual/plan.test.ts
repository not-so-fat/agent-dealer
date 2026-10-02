// scripts/ci-visual/plan.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScreenshotPlan, resolveSeededPath } from "./plan.js";
import { VisualConfigError, type VisualRoute } from "./route-list.js";

const ROUTES: VisualRoute[] = [
  { name: "issues-home", path: "/issues", needsSeededIssue: false },
  { name: "agents", path: "/agents", needsSeededIssue: false },
];

test("builds one shot per (route, width) with unique filenames", () => {
  const plan = buildScreenshotPlan(ROUTES, [1280, 320]);
  assert.equal(plan.length, 4);
  assert.deepEqual(
    plan.map((shot) => shot.filename),
    ["issues-home-1280px.png", "issues-home-320px.png", "agents-1280px.png", "agents-320px.png"]
  );
  assert.deepEqual(plan[0], {
    name: "issues-home",
    route: "/issues",
    path: "/issues",
    width: 1280,
    filename: "issues-home-1280px.png",
  });
});

test("duplicate widths fail the plan", () => {
  assert.throws(
    () => buildScreenshotPlan(ROUTES, [1280, 1280]),
    (err: unknown) =>
      err instanceof VisualConfigError && err.message.includes("duplicate viewport width 1280")
  );
});

test("invalid widths fail the plan", () => {
  assert.throws(() => buildScreenshotPlan(ROUTES, []), VisualConfigError);
  assert.throws(() => buildScreenshotPlan(ROUTES, [0]), VisualConfigError);
  assert.throws(() => buildScreenshotPlan(ROUTES, [-320]), VisualConfigError);
  assert.throws(() => buildScreenshotPlan(ROUTES, [1279.5]), VisualConfigError);
});

test("empty route list fails the plan", () => {
  assert.throws(() => buildScreenshotPlan([], [1280]), VisualConfigError);
});

test("seed placeholders resolve, unknown placeholders fail", () => {
  assert.equal(resolveSeededPath("/issues/{{issueId}}", { issueId: "abc-123" }), "/issues/abc-123");
  assert.equal(resolveSeededPath("/issues", { issueId: "abc-123" }), "/issues");
  assert.throws(
    () => resolveSeededPath("/issues/{{issueId}}", {}),
    (err: unknown) =>
      err instanceof VisualConfigError && err.message.includes('needs a seed value for "{{issueId}}"')
  );
});
