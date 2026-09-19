/**
 * NOT-80 regression: the Agents form must expose only role-neutral model/budget/effort
 * fields for developer/reviewer configuration. The plan/execute pair lived here until
 * NOT-71 retired the legacy queue; collapsing it behind "Legacy queue settings" is moot
 * once that product is gone — this contract locks the declutter so the fields cannot
 * quietly return to the primary form surface.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const formPath = path.join(repoRoot, "apps/web/src/AgentConfigFields.tsx");
const pagePath = path.join(repoRoot, "apps/web/src/pages/AgentsPage.tsx");

test("NOT-80: AgentConfigFields has no plan/execute model+budget controls", () => {
  const src = fs.readFileSync(formPath, "utf8");

  assert.match(src, /defaultModel/);
  assert.match(src, /defaultBudget/);
  assert.match(src, /Issue-centric session defaults/);

  for (const forbidden of [
    "defaultPlanModel",
    "defaultExecuteModel",
    "defaultPlanBudget",
    "defaultExecuteBudget",
    "PhaseConfigRow",
  ]) {
    assert.equal(
      src.includes(forbidden),
      false,
      `${forbidden} must not appear in AgentConfigFields — issue roles only use role-neutral fields`
    );
  }

  // Pre-NOT-71 phase row headings; a collapsed "Legacy queue settings" section would
  // still be wrong after NOT-71 deleted the legacy queue product.
  assert.equal(src.includes('phase="Plan"'), false);
  assert.equal(src.includes('phase="Execution"'), false);
});

test("NOT-80: AgentsPage create/update payloads only send role-neutral defaults", () => {
  const src = fs.readFileSync(pagePath, "utf8");

  assert.match(src, /defaultModel:/);
  assert.match(src, /defaultBudget:/);
  assert.match(src, /resolveProfileModel/);

  for (const forbidden of [
    "defaultPlanModel",
    "defaultExecuteModel",
    "defaultPlanBudget",
    "defaultExecuteBudget",
  ]) {
    assert.equal(
      src.includes(forbidden),
      false,
      `${forbidden} must not be read or written from AgentsPage`
    );
  }
});
