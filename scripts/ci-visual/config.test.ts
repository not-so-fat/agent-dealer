// NOT-385: the real ui-screenshots.json loads through the validated loader and
// captures the populated Issues route in both order states at the required
// viewports — newest-first (default) and oldest-first (reversed direction).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRouteList } from "./route-list.js";
import { buildScreenshotPlan } from "./plan.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const raw = JSON.parse(fs.readFileSync(join(root, "ui-screenshots.json"), "utf8")) as unknown;
const list = loadRouteList(raw);
const plan = buildScreenshotPlan(list.routes, list.viewports);

test("the visual config requires the desktop and narrow viewports", () => {
  for (const [width, height] of [[1440, 900], [390, 800]] as const) {
    assert.ok(
      list.viewports.some((v) => v.width === width && v.height === height),
      `viewport ${width}x${height} is captured`
    );
  }
});

test("the Issues route is captured newest-first and oldest-first", () => {
  const paths = list.routes.map((r) => r.path);
  assert.ok(paths.includes("/issues"), "populated Issues route (newest-first default) is captured");
  assert.ok(
    paths.includes("/issues?direction=asc"),
    "populated Issues route in the oldest-first state is captured"
  );
  const filenames = plan.map((s) => s.filename);
  for (const viewport of ["1440x900", "390x800"]) {
    assert.ok(
      filenames.includes(`issues-home-${viewport}.png`),
      `newest-first screenshot at ${viewport}`
    );
    assert.ok(
      filenames.includes(`issues-oldest-first-${viewport}.png`),
      `oldest-first screenshot at ${viewport}`
    );
  }
});

test("NOT-490: queued and active pre-decision issue details are captured at both viewports", () => {
  const byName = new Map(list.routes.map((r) => [r.name, r]));
  assert.equal(byName.get("issue-detail-queued-auto-merge")?.path, "/issues/{{queuedIssueId}}");
  assert.equal(byName.get("issue-detail-active-auto-merge")?.path, "/issues/{{activeIssueId}}");
  // No steps: the selectors would also run against the base build, which has no switch.
  assert.deepEqual(byName.get("issue-detail-queued-auto-merge")?.steps, []);
  assert.deepEqual(byName.get("issue-detail-active-auto-merge")?.steps, []);
  const filenames = plan.map((s) => s.filename);
  for (const name of ["issue-detail-queued-auto-merge", "issue-detail-active-auto-merge"]) {
    for (const viewport of ["1440x900", "390x800"]) {
      assert.ok(filenames.includes(`${name}-${viewport}.png`), `${name} at ${viewport}`);
    }
  }
});
