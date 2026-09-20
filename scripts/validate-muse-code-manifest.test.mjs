import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const MANIFEST = "docs/evaluations/muse-code/tasks.json";

// Runs the validator on a mutated copy of the committed manifest.
function validate(mutate = () => {}) {
  const m = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  mutate(m);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-manifest-"));
  const file = path.join(dir, "tasks.json");
  fs.writeFileSync(file, JSON.stringify(m));
  const r = spawnSync("node", ["scripts/validate-muse-code-manifest.mjs", file], { encoding: "utf8" });
  fs.rmSync(dir, { recursive: true });
  return r;
}

test("the committed manifest is valid", () => {
  const r = validate();
  assert.equal(r.status, 0, r.stderr);
});
test("a task count other than 5 is rejected", () => {
  const r = validate((m) => m.tasks.pop());
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /exactly 5/);
});
test("a startingSha that is not a commit is rejected", () => {
  const r = validate((m) => (m.tasks[0].startingSha = "0".repeat(40)));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not a commit/);
});
test("a held-out path missing at referenceSha is rejected", () => {
  const r = validate((m) => (m.tasks[0].verification.heldOutPaths = ["packages/nope.test.ts"]));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /held-out path/);
});
test("a task that is not marked non-sensitive is rejected", () => {
  const r = validate((m) => delete m.tasks[0].sensitivity);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /non_sensitive/);
});
test("a subject with a descriptive model is rejected", () => {
  const r = validate((m) => (m.candidate.model = "current contributor model"));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /explicit id/);
});
