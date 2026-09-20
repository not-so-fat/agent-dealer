import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const MANIFEST = "docs/evaluations/muse-code/tasks.json";

function ready(mutate) {
  const m = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  m.candidate.confirmation.confirmedAt = "2026-09-20T00:00:00Z";
  m.candidate.confirmation.confirmedBy = "operator";
  mutate(m.candidate.tokenMapping);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-ready-"));
  const file = path.join(dir, "tasks.json");
  fs.writeFileSync(file, JSON.stringify(m));
  const r = spawnSync("node", ["scripts/validate-muse-code-manifest.mjs", "--ready", file], { encoding: "utf8" });
  fs.rmSync(dir, { recursive: true });
  return r;
}
const fill = (tm, raw, inclusion = true, attested = true) => {
  tm.rawFields = raw;
  tm.inputIncludesCached = inclusion;
  tm.mappingRecordedInRunPlan = attested;
};
const paths = { input: "usage.input_tokens", cache_read: "usage.cached_tokens", cache_write: "usage.cache_write_tokens", output: "usage.output_tokens" };

test("--ready fails on the committed manifest until the mapping is recorded", () => {
  assert.notEqual(ready(() => {}).status, 0);
});
test("--ready accepts a fully recorded mapping", () => {
  assert.equal(ready((tm) => fill(tm, paths)).status, 0);
});
test("--ready requires the attestation flag", () => {
  const r = ready((tm) => fill(tm, paths, true, false));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /mappingRecordedInRunPlan/);
});
test("--ready accepts none for a missing billing tier and unreported for the null-cost case", () => {
  assert.equal(ready((tm) => fill(tm, { ...paths, cache_read: "none", cache_write: "none" }, "not_applicable")).status, 0);
  assert.equal(ready((tm) => fill(tm, { ...paths, cache_read: "unreported", cache_write: "unreported" }, "not_applicable")).status, 0);
  assert.equal(ready((tm) => fill(tm, { input: "unreported", cache_read: "unreported", cache_write: "none", output: "unreported" }, "not_applicable")).status, 0);
});
test("--ready rejects none for input/output, prose, and null fields", () => {
  assert.notEqual(ready((tm) => fill(tm, { ...paths, input: "none" })).status, 0);
  assert.notEqual(ready((tm) => fill(tm, { ...paths, output: "none" })).status, 0);
  assert.notEqual(ready((tm) => fill(tm, { ...paths, output: "raw output tokens" })).status, 0);
  assert.notEqual(ready((tm) => fill(tm, { ...paths, cache_read: null })).status, 0);
});
test("--ready requires a boolean inclusion flag when input and cache_read are both fields", () => {
  assert.notEqual(ready((tm) => fill(tm, paths, "not_applicable")).status, 0);
  assert.notEqual(ready((tm) => fill(tm, paths, null)).status, 0);
});
