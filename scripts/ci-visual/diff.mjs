// scripts/ci-visual/diff.mjs
//
// Pixel diff for the CI `visual` job (NOT-383). Plain node ESM with no repo
// dependencies: the workflow copies it into the scratch Playwright dir where
// `pixelmatch` + `pngjs` are installed, so the repo takes no new dependency.
//
// Report-only by construction: a nonzero diff is recorded in the summary, and
// this script exits 0 whenever the summary was written.
//
// Usage:
//   node diff.mjs --baseline ui-baseline --head ui-screenshots \
//     --plan ui-screenshots/plan.json --out ui-diff \
//     --base-sha <sha> --head-sha <sha>

import fs from "node:fs";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

function flagValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index !== -1 && index + 1 < process.argv.length) {
    const value = process.argv[index + 1];
    if (value !== undefined && value !== "") return value;
  }
  return fallback;
}

function describeSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return "—";
  return steps
    .map((s) => (s.name ? `${s.action} ${s.by}:${s.value} "${s.name}"` : `${s.action} ${s.by}:${s.value}`))
    .join("; ");
}

/** Extend an RGBA buffer onto a larger canvas, padding with transparent black. */
function extendToCanvas(img, width, height) {
  const canvas = Buffer.alloc(width * height * 4);
  for (let y = 0; y < img.height; y++) {
    img.data.copy(canvas, y * width * 4, y * img.width * 4, (y + 1) * img.width * 4);
  }
  return canvas;
}

function diffPair(baselinePng, headPng) {
  // fullPage captures vary in height with content, so the canvases often
  // differ: compare on the max canvas, counting pixels outside either image
  // (zero-padded) as changed.
  const width = Math.max(baselinePng.width, headPng.width);
  const height = Math.max(baselinePng.height, headPng.height);
  const baseline = extendToCanvas(baselinePng, width, height);
  const head = extendToCanvas(headPng, width, height);
  const diff = new PNG({ width, height });
  const changed = pixelmatch(baseline, head, diff.data, width, height, { threshold: 0.1 });
  const total = width * height;
  return { changed, ratio: total === 0 ? 0 : changed / total, diffPng: diff };
}

function main() {
  const baselineDir = flagValue("--baseline");
  const headDir = flagValue("--head");
  const planPath = flagValue("--plan");
  const outDir = flagValue("--out");
  const baseSha = flagValue("--base-sha");
  const headSha = flagValue("--head-sha");
  for (const [name, value] of [
    ["--baseline", baselineDir],
    ["--head", headDir],
    ["--plan", planPath],
    ["--out", outDir],
    ["--base-sha", baseSha],
    ["--head-sha", headSha],
  ]) {
    if (!value) throw new Error(`diff.mjs needs ${name} (see header usage)`);
  }

  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new Error(`screenshot plan at ${planPath} is empty`);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const rows = [];
  for (const shot of plan) {
    const headFile = path.join(headDir, shot.filename);
    const baselineFile = path.join(baselineDir, shot.filename);
    const steps = describeSteps(shot.steps);
    if (!fs.existsSync(headFile)) {
      console.log(`[diff] ${shot.filename}: no head capture`);
      rows.push({ shot, steps, changed: null, ratio: null, note: "no head capture" });
      continue;
    }
    if (!fs.existsSync(baselineFile)) {
      console.log(`[diff] ${shot.filename}: no baseline capture`);
      rows.push({ shot, steps, changed: null, ratio: null, note: "no baseline capture" });
      continue;
    }
    const baselinePng = PNG.sync.read(fs.readFileSync(baselineFile));
    const headPng = PNG.sync.read(fs.readFileSync(headFile));
    const { changed, ratio, diffPng } = diffPair(baselinePng, headPng);
    const diffFilename = `diff-${shot.filename}`;
    fs.writeFileSync(path.join(outDir, diffFilename), PNG.sync.write(diffPng));
    console.log(
      `[diff] ${shot.filename}: ${changed} px changed (${(ratio * 100).toFixed(2)}%) -> ${diffFilename}`
    );
    rows.push({ shot, steps, changed, ratio, note: null });
  }

  const lines = [
    "## UI diff (base vs head, report-only)",
    "",
    `head: \`${headSha}\``,
    "",
    `base: \`${baseSha}\``,
    "",
    "A nonzero diff never fails the job — this table is evidence for reviewers.",
    "",
    "| route | viewport | steps | changed px | changed | head SHA | base SHA |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) =>
      [
        `\`${row.shot.route}\``,
        row.shot.viewport,
        row.steps,
        row.changed === null ? `n/a (${row.note})` : String(row.changed),
        row.ratio === null ? "n/a" : `${(row.ratio * 100).toFixed(2)}%`,
        `\`${headSha}\``,
        `\`${baseSha}\``,
      ].join(" | ").replace(/^/, "| ").concat(" |")
    ),
    "",
  ];
  fs.writeFileSync(path.join(outDir, "SUMMARY.md"), `${lines.join("\n")}\n`);
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) fs.appendFileSync(summaryFile, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
}

main();
