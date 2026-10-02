// scripts/ci-visual/capture.mts
//
// CI driver for the `visual` job (NOT-312). Runs under tsx with stdlib only:
// loads ui-screenshots.json, seeds a deterministic fixture issue through the
// public API, resolves `{{issueId}}`, and writes plan.json for visual.spec.mjs.
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
import { randomUUID } from "node:crypto";
import { loadRouteList } from "./route-list.js";
import { buildScreenshotPlan, resolveSeededPath } from "./plan.js";

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
  // never starts a workflow for it). Random agent UUIDs are fine — issue
  // creation stores them without resolving agents through Agent Deck.
  const seed = (await postJson(`${baseUrl}/api/issues`, {
    title: "CI visual fixture",
    description: "Deterministic seed for the CI visual screenshot job (NOT-312).",
    acceptanceCriteria: "Screenshots render for the configured routes.",
    repo: "not-so-fat/agent-dealer",
    developerAgentId: randomUUID(),
    reviewerAgentId: randomUUID(),
    enqueue: false,
    source: "manual",
  })) as { id?: unknown };
  if (typeof seed.id !== "string" || seed.id === "") {
    throw new Error("seed issue response is missing an id");
  }
  const confirmed = (await readJson(`${baseUrl}/api/issues/${seed.id}`)) as { id?: unknown };
  if (confirmed.id !== seed.id) {
    throw new Error(`seed issue ${seed.id} did not read back`);
  }

  const seeds: Record<string, string> = { issueId: seed.id };
  const resolvedRoutes = list.routes.map((route) => ({
    ...route,
    path: resolveSeededPath(route.path, seeds),
  }));
  const plan = buildScreenshotPlan(resolvedRoutes, list.widths);

  fs.mkdirSync(outDir, { recursive: true });
  const shots = plan.map((shot) => ({
    name: shot.name,
    route: shot.route,
    url: `${baseUrl}${shot.path}`,
    width: shot.width,
    filename: shot.filename,
  }));
  fs.writeFileSync(path.join(outDir, "plan.json"), `${JSON.stringify(shots, null, 2)}\n`);

  console.log(`[ci-visual] seeded issue ${seed.id}`);
  for (const shot of shots) {
    console.log(`[ci-visual] shot ${shot.filename} ${shot.route} ${shot.width}px`);
  }
}

main().catch((err) => {
  console.error(`[ci-visual] ${(err as Error).message}`);
  process.exit(1);
});
