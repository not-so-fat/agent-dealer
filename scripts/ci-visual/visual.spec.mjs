// scripts/ci-visual/visual.spec.mjs
//
// Playwright spec for the CI `visual` job (NOT-312). Runs inside a scratch
// @playwright/test install (see .github/workflows/visual.yml), NOT from repo
// node_modules — the repo never depends on Playwright.
//
// Env:
//   CI_VISUAL_PLAN    absolute path to plan.json written by capture.mts
//   CI_VISUAL_OUT_DIR absolute directory for the PNGs
//   GITHUB_STEP_SUMMARY (optional, set by Actions) receives the image table
//
// Every listed route must render: an empty body or the app's NotFoundPage
// fails that route's test and therefore the job — a missing/typo'd route can
// never silently produce a blank screenshot.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const planPath = process.env.CI_VISUAL_PLAN ?? "";
const outDir = process.env.CI_VISUAL_OUT_DIR ?? "";
if (!planPath || !outDir) {
  throw new Error("visual.spec.mjs needs CI_VISUAL_PLAN and CI_VISUAL_OUT_DIR set");
}

const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
if (!Array.isArray(plan) || plan.length === 0) {
  throw new Error(`screenshot plan at ${planPath} is empty`);
}

test.setTimeout(90_000);

const captured = [];

for (const shot of plan) {
  test(`${shot.name} renders at ${shot.width}px`, async ({ page }) => {
    await page.setViewportSize({ width: shot.width, height: 800 });
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
    const out = path.join(outDir, shot.filename);
    await page.screenshot({ path: out, fullPage: true });
    expect(fs.existsSync(out)).toBe(true);
    captured.push(shot);
  });
}

test("summary links every image to its route and width", async () => {
  expect(captured.length).toBe(plan.length);
  for (const shot of plan) {
    const size = fs.statSync(path.join(outDir, shot.filename)).size;
    expect(size).toBeGreaterThan(0);
  }
  const lines = [
    "## UI screenshots",
    "",
    "| image | route | width |",
    "| --- | --- | --- |",
    ...plan.map((shot) => `| \`${shot.filename}\` | \`${shot.route}\` | ${shot.width}px |`),
    "",
  ];
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) fs.appendFileSync(summaryFile, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
});
