// packages/server/src/docs-execution-analysis.test.ts
//
// NOT-167: docs/EXECUTION_ANALYSIS.md is the canonical execution-analysis contract. Guards
// that the architecture/data-model docs keep linking to it (instead of restating it) and
// that the contract keeps its required vocabulary and the silence-is-observational rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

const CANONICAL = "docs/EXECUTION_ANALYSIS.md";

test("the execution-analysis contract exists", () => {
  assert.ok(fs.existsSync(path.join(repoRoot, CANONICAL)));
});

test("data-model, PRD, and README link to the canonical contract", () => {
  for (const [file, link] of [
    ["docs/DATA_MODEL.md", "](EXECUTION_ANALYSIS.md)"],
    ["docs/PRD_ISSUE_COORDINATION.md", "](EXECUTION_ANALYSIS.md)"],
    ["README.md", "](docs/EXECUTION_ANALYSIS.md)"],
  ] as const) {
    assert.ok(read(file).includes(link), `${file} must link to ${CANONICAL}`);
  }
});

test("relative markdown links in the contract resolve to real files", () => {
  const doc = read(CANONICAL);
  const targets = [...doc.matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)].map((m) => m[1]!);
  assert.ok(targets.length > 0);
  for (const t of targets) {
    assert.ok(fs.existsSync(path.join(repoRoot, "docs", t)), `broken link: ${t}`);
  }
});

test("in-document anchors in the contract resolve to headings", () => {
  const doc = read(CANONICAL);
  const slug = (h: string) =>
    h.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/ /g, "-");
  const anchors = new Set(
    [...doc.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1]!))
  );
  for (const m of doc.matchAll(/\]\(#([^)]+)\)/g)) {
    assert.ok(anchors.has(m[1]!), `unresolved anchor #${m[1]}`);
  }
});

test("the contract defines every phase, taxonomy code, and quality label", () => {
  const doc = read(CANONICAL);
  const required = [
    "queue_wait",
    "coordinator_setup",
    "agent_process",
    "coordinator_validation_publish",
    "human_wait",
    "admission_dependency_wait",
    "runtime_health_preflight",
    "unexplained_silence",
    "[start, end)",
    "nearest-rank",
    "rowid",
    "exact",
    "inferred",
    "unavailable",
    // silence taxonomy
    "model_provider_wait",
    "tool_or_subprocess_in_flight",
    "host_suspended",
    "no_structured_output",
    // failure taxonomy
    "authentication_configuration",
    "provider_capacity_rate_limit",
    "agent_cli_crash",
    "tool_test_timeout",
    "coordinator_crash",
    "validation_failure",
    "publish_git_failure",
    "agent_deck_unavailable",
    "host_sleep_liveness",
  ];
  for (const term of required) assert.ok(doc.includes(term), `missing: ${term}`);
});

test("the contract states silence cannot drive control-plane behavior", () => {
  const doc = read(CANONICAL);
  assert.match(doc, /Silence must not drive control-plane behavior/);
  for (const word of ["retry", "termination", "scheduling", "leases", "admission"]) {
    assert.ok(doc.includes(word), `silence rule must mention ${word}`);
  }
});

test("the contract separates immutable evidence from mutable source records", () => {
  const doc = read(CANONICAL);
  assert.match(doc, /\*\*Immutable evidence\*\*/);
  assert.match(doc, /\*\*Mutable source records\*\*/);
  assert.doesNotMatch(doc, /Raw evidence is append-only/);
});

test("the contract defines partial-sample quality without a conflicting weakest-input rule", () => {
  const doc = read(CANONICAL);
  assert.ok(doc.includes("partial_sample"));
  assert.match(doc, /Value metrics/);
  assert.doesNotMatch(doc, /takes the \*\*weakest\*\* input quality/);
  assert.doesNotMatch(doc, /`quality: inferred`, reason `missing_provider_metadata` \(partial\)/);
});

test("worker_sessions.completed_at alone is not treated as agent.completed", () => {
  const doc = read(CANONICAL);
  assert.match(doc, /`worker_sessions\.completed_at` alone[^|]*`unavailable`/);
  assert.ok(doc.includes("no_defensible_boundary"));
});

test("usage_events timing is documented as a spawn envelope, not CLI lifetime", () => {
  const doc = read(CANONICAL);
  assert.match(doc, /### 6\.1 Usage-event timing/);
  assert.ok(doc.includes("spawn_envelope"));
  assert.ok(doc.includes("acquireSpawnSlot"));
  assert.ok(doc.includes("persistVerificationReceiptIfAny"));
  assert.ok(doc.includes("includes_spawn_slot_wait"));
  assert.ok(doc.includes("includes_post_exit_work"));
  assert.doesNotMatch(doc, /spawn wall time/);
  assert.doesNotMatch(doc, /`duration_ms` is measured from just before spawn/);
  assert.match(doc, /`usage_events\.ts − usage_events\.duration_ms` is not a proxy/);
});
