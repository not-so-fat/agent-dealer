// scripts/ci-visual/visual.spec.mjs
//
// Playwright spec for the CI `visual` job (NOT-312, NOT-383). Runs inside a
// scratch @playwright/test install (see .github/workflows/visual.yml), NOT from
// repo node_modules — the repo never depends on Playwright. width-check.mjs is
// copied next to this file so the width verdict is the unit-tested helper.
//
// Env:
//   CI_VISUAL_PLAN    absolute path to plan.json written by capture.mts
//   CI_VISUAL_OUT_DIR absolute directory for the PNGs
//   CI_VISUAL_LABEL   optional capture label ("head" or "baseline") for the summary
//   GITHUB_STEP_SUMMARY (optional, set by Actions) receives the image table
//
// Every listed route must render: an empty body or the app's NotFoundPage
// fails that route's test and therefore the job — a missing/typo'd route can
// never silently produce a blank screenshot. After the route's interaction
// steps run, the page must fit its viewport width (NOT-383 width assertion).

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { checkFitsViewport } from "./width-check.mjs";

const planPath = process.env.CI_VISUAL_PLAN ?? "";
const outDir = process.env.CI_VISUAL_OUT_DIR ?? "";
const label = process.env.CI_VISUAL_LABEL ?? "";
if (!planPath || !outDir) {
  throw new Error("visual.spec.mjs needs CI_VISUAL_PLAN and CI_VISUAL_OUT_DIR set");
}

const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
if (!Array.isArray(plan) || plan.length === 0) {
  throw new Error(`screenshot plan at ${planPath} is empty`);
}

test.setTimeout(90_000);

function locatorFor(page, step) {
  if (step.by === "testid") return page.getByTestId(step.value);
  if (step.by === "label") return page.getByLabel(step.value);
  if (step.by === "role") {
    return step.name ? page.getByRole(step.value, { name: step.name }) : page.getByRole(step.value);
  }
  throw new Error(`unknown step selector ${JSON.stringify(step.by)} (expected "role", "label", or "testid")`);
}

function describeStep(step) {
  const target = step.name ? `${step.by}:${step.value} "${step.name}"` : `${step.by}:${step.value}`;
  return `${step.action} ${target}`;
}

const captured = [];

for (const shot of plan) {
  test(`${shot.name} renders at ${shot.viewport}${shot.steps?.length ? " (with interaction)" : ""}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: shot.width, height: shot.height });
    await page.goto(shot.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => ((document.body && document.body.innerText) || "").trim().length > 0,
      null,
      { timeout: 15_000 }
    );
    const text = await page.evaluate(() => (document.body && document.body.innerText) || "");
    // The SPA serves index.html for unknown paths, so a wrong route renders
    // the app's 404 page instead of an HTTP error — reject it explicitly.
    expect(text).not.toContain("That URL is not a destination in Agent Dealer.");
    for (const step of shot.steps ?? []) {
      const locator = locatorFor(page, step);
      if (step.action === "click") {
        await locator.click({ timeout: 15_000 });
      } else if (step.action === "waitFor") {
        await locator.waitFor({ state: "visible", timeout: 15_000 });
      } else {
        throw new Error(`unknown step action ${JSON.stringify(step.action)} (expected "click" or "waitFor")`);
      }
      console.log(`[steps] ${shot.filename}: ${describeStep(step)}`);
    }
    // NOT-383 width assertion: after the steps run, the page must be no wider
    // than its viewport. Checked before the fullPage screenshot resizes anything.
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const verdict = checkFitsViewport({
      scrollWidth,
      viewportWidth: shot.width,
      route: shot.route,
      viewport: shot.viewport,
    });
    console.log(verdict.message);
    expect(verdict.ok, verdict.message).toBe(true);
    const out = path.join(outDir, shot.filename);
    await page.screenshot({ path: out, fullPage: true });
    expect(fs.existsSync(out)).toBe(true);
    captured.push(shot);
  });
}

test("summary links every image to its route, viewport, and steps", async () => {
  expect(captured.length).toBe(plan.length);
  for (const shot of plan) {
    const size = fs.statSync(path.join(outDir, shot.filename)).size;
    expect(size).toBeGreaterThan(0);
  }
  const heading = label ? `## UI screenshots (${label})` : "## UI screenshots";
  const lines = [
    heading,
    "",
    "| image | route | viewport | steps |",
    "| --- | --- | --- | --- |",
    ...plan.map((shot) => {
      const steps = (shot.steps ?? []).map(describeStep).join("; ") || "—";
      return `| \`${shot.filename}\` | \`${shot.route}\` | ${shot.viewport} | ${steps} |`;
    }),
    "",
  ];
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) fs.appendFileSync(summaryFile, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
});
