// packages/server/src/coordinator/workflows/registry.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";

const { registerWorkflow, getWorkflow, listWorkflows, resetWorkflows } = await import(
  "./registry.js"
);
const { DEV_REVIEWER_V1_VERSION, devReviewerV1 } = await import("./dev-reviewer-v1.js");

after(() => {
  // Other coordinator test files in this process may start workflows; keep the
  // builtin registered after this file mutates the map.
  registerWorkflow(devReviewerV1);
});

test("getWorkflow(dev_reviewer_v1) returns the registered template", () => {
  const template = getWorkflow(DEV_REVIEWER_V1_VERSION);
  assert.equal(template.version, DEV_REVIEWER_V1_VERSION);
  assert.deepEqual(template.roles, ["developer", "reviewer"]);
  assert.deepEqual(template.effectKinds, ["developer", "reviewer"]);
});

test("listWorkflows includes dev_reviewer_v1", () => {
  assert.ok(
    listWorkflows().some((t) => t.version === DEV_REVIEWER_V1_VERSION),
    "listWorkflows() should include the registered Dev-review template"
  );
});

test("getWorkflow(unknown) throws a clear error — no silent Dev-review fallback", () => {
  assert.throws(
    () => getWorkflow("__no_such_workflow_template__"),
    (err: unknown) =>
      err instanceof Error &&
      /Unknown workflow template: __no_such_workflow_template__/.test(err.message)
  );
});

test("a second template is one registerWorkflow call", () => {
  const peer: typeof devReviewerV1 = {
    version: "clarify_v1_test_only",
    roles: ["developer"],
    effectKinds: ["developer"],
  };
  registerWorkflow(peer);
  assert.equal(getWorkflow("clarify_v1_test_only").version, "clarify_v1_test_only");
  assert.ok(listWorkflows().some((t) => t.version === "clarify_v1_test_only"));
  // Leave peer registered — harmless; versions are unique.
});

test("resetWorkflows clears the map (test hook)", () => {
  resetWorkflows();
  assert.throws(() => getWorkflow(DEV_REVIEWER_V1_VERSION), /Unknown workflow template/);
  registerWorkflow(devReviewerV1);
  assert.equal(getWorkflow(DEV_REVIEWER_V1_VERSION).version, DEV_REVIEWER_V1_VERSION);
});
