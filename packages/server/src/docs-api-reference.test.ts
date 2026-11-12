// NOT-575: docs/API.md is the canonical guidance/resolve reference. Guards
// that it documents both payloads and that every stored choice per action
// type appears in it — the doc is generated from the same constants the
// server validates against, so drift fails here instead of surprising an
// operator at resolve time.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-docs-api-"));

const { responseOptionsFor } = await import("./coordinator/commands.js");
const { PRODUCT_SCOPE_NOTE_MAX_CHARS } = await import("./coordinator/human-resolution.js");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const API_REF = "docs/API.md";
const read = () => fs.readFileSync(path.join(repoRoot, API_REF), "utf8");

test("the API reference exists and names the discovery fields", () => {
  assert.ok(fs.existsSync(path.join(repoRoot, API_REF)));
  const doc = read();
  // The acceptance evidence: rg -n "responseOptions|resolvedBy" docs/API.md.
  assert.match(doc, /responseOptions/);
  assert.match(doc, /resolvedBy/);
});

test("the guidance payload is documented with its markdown field", () => {
  const doc = read();
  assert.match(doc, /POST \/api\/issues\/:id\/guidance/);
  assert.match(doc, /"markdown"/);
});

test("the resolve payload is documented with resolvedBy, choice, and note", () => {
  const doc = read();
  assert.match(doc, /POST \/api\/human-actions\/:id\/resolve/);
  assert.match(doc, /"resolvedBy"/);
  assert.match(doc, /"choice"/);
  assert.match(doc, /"note"/);
  assert.ok(doc.includes(String(PRODUCT_SCOPE_NOTE_MAX_CHARS)), "the note cap must match code");
});

test("every stored choice per action type appears in the reference", () => {
  const doc = read();
  const stored: Array<{ choice: string }> = [
    ...responseOptionsFor("final_review"),
    ...responseOptionsFor("attempts_exhausted"),
    ...responseOptionsFor("policy_escalation"),
    ...responseOptionsFor("policy_escalation", false, { mergeFailure: true }),
    ...responseOptionsFor("policy_escalation", false, {
      pushDivergence: {
        branch: "b",
        localSha: "l",
        remoteSha: "r",
        ahead: 1,
        behind: 1,
        relationship: "diverged",
      },
    }),
    ...responseOptionsFor("product_scope_decision"),
    ...responseOptionsFor("operator_verification"),
  ];
  for (const { choice } of stored) {
    assert.ok(doc.includes(`\`${choice}\``), `missing stored choice: ${choice}`);
  }
  // Accepted but not stored: the final_review legacy synonym (VALID_CHOICES in
  // human-resolution.ts) and the special-resolver sets (reflect-trigger.ts,
  // approve-deliver.ts, commands.ts's muse branch, linear-merge-verify.ts).
  for (const choice of [
    "complete",
    "retry",
    "dismiss",
    "retry_send",
    "reject",
    "acknowledge",
    "recheck",
  ]) {
    assert.ok(doc.includes(`\`${choice}\``), `missing accepted choice: ${choice}`);
  }
  // Every action type has a row.
  for (const actionType of [
    "final_review",
    "attempts_exhausted",
    "policy_escalation",
    "product_scope_decision",
    "deck_interaction_required",
    "reflection_interaction_required",
    "outbound_delivery_interaction_required",
    "muse_capability",
    "operator_verification",
  ]) {
    assert.ok(doc.includes(`\`${actionType}\``), `missing action type: ${actionType}`);
  }
});
