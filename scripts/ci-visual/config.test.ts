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
