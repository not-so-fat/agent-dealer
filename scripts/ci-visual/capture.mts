// scripts/ci-visual/capture.mts
//
// CI driver for the `visual` job (NOT-312, NOT-383). Runs under tsx with stdlib
// only: loads ui-screenshots.json, seeds deterministic fixture issues (two
// drafts since NOT-385, so list order is visible) plus a guidance timeline
// event through the public API, resolves `{{issueId}}`, and writes plan.json
// for visual.spec.mjs.
// The browser capture itself happens in the Playwright spec, which asserts
// every listed route actually renders (failing the job otherwise).
//
// Usage:
//   npx tsx scripts/ci-visual/capture.mts \
//     --base-url http://127.0.0.1:3221 \
//     --config ui-screenshots.json \
//     --out-dir ui-screenshots

import fs from "node:fs";
import path from "node:path";
import { loadRouteList } from "./route-list.js";
import { buildScreenshotPlan, resolveSeededPath } from "./plan.js";

// Built-in agents seeded by migrate() into a fresh AGENT_DEALER_HOME
// (seedBuiltinAgents in packages/server/src/db/index.ts; IDs documented as
// stable in packages/shared/src/agents.ts). The repo's own route tests use
// these same IDs. Hardcoded here so the driver stays stdlib-only.
const BUILTIN_AGENT_CLAUDE_ID = "00000000-0000-4000-a000-000000000001";
const BUILTIN_AGENT_CURSOR_ID = "00000000-0000-4000-a000-000000000002";

function flagValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index !== -1 && index + 1 < process.argv.length) {
    const value = process.argv[index + 1];
    if (value !== undefined && value !== "") return value;
  }
  return fallback;
}

async function readJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return (await res.json()) as unknown;
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${url} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as unknown;
}

async function main(): Promise<void> {
  const baseUrl = flagValue("--base-url", "http://127.0.0.1:3221").replace(/\/+$/, "");
  const configPath = flagValue("--config", "ui-screenshots.json");
  const outDir = flagValue("--out-dir", "ui-screenshots");

  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  const list = loadRouteList(raw);

  // Fail fast when the server is not up before touching fixtures.
  await readJson(`${baseUrl}/health`);

  // Deterministic fixture: one draft issue (enqueue:false so the coordinator
  // never starts a workflow for it). issues.developer_agent_id /
  // reviewer_agent_id are FKs into agents(id), so random UUIDs fail with
  // SQLITE_CONSTRAINT_FOREIGNKEY — use the built-in agents instead.
  const seed = (await postJson(`${baseUrl}/api/issues`, {
    title: "CI visual fixture",
    description: "Deterministic seed for the CI visual screenshot job (NOT-312).",
    acceptanceCriteria: "Screenshots render for the configured routes.",
    repo: "not-so-fat/agent-dealer",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    enqueue: false,
    source: "manual",
  })) as { id?: unknown };
  if (typeof seed.id !== "string" || seed.id === "") {
    throw new Error("seed issue response is missing an id");
  }
  // NOT-385: a second draft so the newest-first and oldest-first Issues
  // captures show opposite row orders — with two rows the direction-aware
  // tie-breaker guarantees the reverse even when timestamps collide.
  const seed2 = (await postJson(`${baseUrl}/api/issues`, {
    title: "CI visual fixture (second)",
    description: "Second deterministic seed so list order is visible (NOT-385).",
    acceptanceCriteria: "Screenshots render for the configured routes.",
    repo: "not-so-fat/agent-dealer",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    enqueue: false,
    source: "manual",
  })) as { id?: unknown };
  if (typeof seed2.id !== "string" || seed2.id === "") {
    throw new Error("second seed issue response is missing an id");
  }
  // GET /api/issues/:id returns `{ issue, timeline, ... }` (see
  // registerIssueRoutes) — the id lives under `issue`, not top-level.
  const confirmed = (await readJson(`${baseUrl}/api/issues/${seed.id}`)) as {
    issue?: { id?: unknown };
    id?: unknown;
  };
  const confirmedId = typeof confirmed.issue?.id === "string" ? confirmed.issue.id : confirmed.id;
  if (confirmedId !== seed.id) {
    throw new Error(`seed issue ${seed.id} did not read back`);
  }

  // NOT-383: give the fixture a real timeline (beyond `issue.created`) through
  // the public API, so the issue detail capture shows timeline content.
  await postJson(`${baseUrl}/api/issues/${seed.id}/guidance`, {
    markdown: "CI visual fixture guidance — deterministic timeline content (NOT-383).",
  });
  const detail = (await readJson(`${baseUrl}/api/issues/${seed.id}`)) as {
    timeline?: Array<{ type?: unknown }>;
  };
  const timelineTypes = Array.isArray(detail.timeline) ? detail.timeline.map((e) => e.type) : [];
  if (!timelineTypes.includes("guidance.added")) {
    throw new Error(`seed issue ${seed.id} timeline is missing the guidance event`);
  }

  const seeds: Record<string, string> = { issueId: seed.id };
  const resolvedRoutes = list.routes.map((route) => ({
    ...route,
    path: resolveSeededPath(route.path, seeds),
  }));
  const plan = buildScreenshotPlan(resolvedRoutes, list.viewports);

  fs.mkdirSync(outDir, { recursive: true });
  const shots = plan.map((shot) => ({
    name: shot.name,
    route: shot.route,
    url: `${baseUrl}${shot.path}`,
    width: shot.width,
    height: shot.height,
    viewport: shot.viewport,
    steps: shot.steps,
    filename: shot.filename,
  }));
  fs.writeFileSync(path.join(outDir, "plan.json"), `${JSON.stringify(shots, null, 2)}\n`);

  console.log(`[ci-visual] seeded issues ${seed.id} and ${seed2.id} (timeline events: ${timelineTypes.length})`);
  for (const shot of shots) {
    const steps = shot.steps.length > 0 ? ` steps=${shot.steps.length}` : "";
    console.log(`[ci-visual] shot ${shot.filename} ${shot.route} ${shot.viewport}${steps}`);
  }
}

main().catch((err) => {
  console.error(`[ci-visual] ${(err as Error).message}`);
  process.exit(1);
});
