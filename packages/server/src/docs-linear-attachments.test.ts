// NOT-364: docs/LINEAR_INTEGRATION.md is the canonical issue-attachment
// contract — durability, limits, trust boundary, and the comment-only
// exclusion must stay stated there, and the stated limits must match code.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_SOURCE_ATTACHMENT_FILE_BYTES,
  MAX_SOURCE_ATTACHMENT_TOTAL_BYTES,
} from "./coordinator/source-attachments.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const doc = fs.readFileSync(path.join(repoRoot, "docs/LINEAR_INTEGRATION.md"), "utf8");

test("the Linear doc states attachment durability, limits, trust, and exclusions", () => {
  for (const phrase of [
    "### Issue attachments (NOT-364)",
    "100 MiB per file",
    "250 MiB total per issue",
    "External links",
    "never downloaded",
    "comments",
    "never auto-extracted",
    "untrusted ticket inputs",
    "never commit them",
    "fresh contained directory",
    ".agent-dealer-inputs/linear/",
    "Reload from Linear",
    "Reviewers receive the manifest metadata only",
  ]) {
    assert.ok(doc.includes(phrase), `LINEAR_INTEGRATION.md must state: ${phrase}`);
  }
  // The stale line claiming attachments are never imported is gone.
  assert.ok(!doc.includes("attachments are not imported"));
});

test("documented limits match the enforced snapshot caps", () => {
  assert.equal(MAX_SOURCE_ATTACHMENT_FILE_BYTES, 100 * 1024 * 1024);
  assert.equal(MAX_SOURCE_ATTACHMENT_TOTAL_BYTES, 250 * 1024 * 1024);
});
