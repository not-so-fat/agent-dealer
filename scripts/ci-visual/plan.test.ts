// scripts/ci-visual/plan.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScreenshotPlan, resolveSeededPath } from "./plan.js";
import { VisualConfigError, type VisualRoute, type VisualViewport } from "./route-list.js";

const VIEWPORTS: VisualViewport[] = [
  { width: 1440, height: 900 },
  { width: 390, height: 800 },
];

const ROUTES: VisualRoute[] = [
  { name: "issues-home", path: "/issues", needsSeededIssue: false, steps: [] },
  {
    name: "issue-detail",
    path: "/issues/abc-123",
    needsSeededIssue: true,
    steps: [{ action: "click", by: "testid", value: "more-actions-toggle" }],
  },
];

test("builds one shot per (route, viewport) with height and unique filenames", () => {
  const plan = buildScreenshotPlan(ROUTES, VIEWPORTS);
  assert.equal(plan.length, 4);
  assert.deepEqual(
    plan.map((shot) => shot.filename),
    [
      "issues-home-1440x900.png",
      "issues-home-390x800.png",
      "issue-detail-1440x900.png",
      "issue-detail-390x800.png",
    ]
  );
  assert.deepEqual(plan[0], {
    name: "issues-home",
    route: "/issues",
    path: "/issues",
    width: 1440,
    height: 900,
    viewport: "1440x900",
    steps: [],
    filename: "issues-home-1440x900.png",
  });
  assert.deepEqual(plan[2]?.steps, [{ action: "click", by: "testid", value: "more-actions-toggle" }]);
  assert.equal(plan[3]?.width, 390);
  assert.equal(plan[3]?.height, 800);
  assert.equal(plan[3]?.viewport, "390x800");
});

test("duplicate viewports fail the plan", () => {
  assert.throws(
    () =>
      buildScreenshotPlan(ROUTES, [
        { width: 1440, height: 900 },
        { width: 1440, height: 900 },
      ]),
    (err: unknown) =>
      err instanceof VisualConfigError && err.message.includes("duplicate viewport 1440x900")
  );
});

test("same width with different heights is not a duplicate", () => {
  const plan = buildScreenshotPlan(ROUTES.slice(0, 1), [
    { width: 1440, height: 900 },
    { width: 1440, height: 800 },
  ]);
  assert.deepEqual(
    plan.map((shot) => shot.filename),
    ["issues-home-1440x900.png", "issues-home-1440x800.png"]
  );
});

test("invalid viewports fail the plan", () => {
  assert.throws(() => buildScreenshotPlan(ROUTES, []), VisualConfigError);
  assert.throws(() => buildScreenshotPlan(ROUTES, [{ width: 0, height: 900 }]), VisualConfigError);
  assert.throws(() => buildScreenshotPlan(ROUTES, [{ width: 1440, height: 0 }]), VisualConfigError);
  assert.throws(() => buildScreenshotPlan(ROUTES, [{ width: -390, height: 800 }]), VisualConfigError);
  assert.throws(() => buildScreenshotPlan(ROUTES, [{ width: 1439.5, height: 900 }]), VisualConfigError);
});

test("empty route list fails the plan", () => {
  assert.throws(() => buildScreenshotPlan([], VIEWPORTS), VisualConfigError);
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
