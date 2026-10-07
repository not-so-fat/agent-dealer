// NOT-369: product docs describe the caffeinate hold, pmset advice, and limits.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const doc = fs.readFileSync(path.join(repoRoot, "docs/TROUBLESHOOTING.md"), "utf8");

test("TROUBLESHOOTING documents caffeinate hold and pmset advice", () => {
  assert.match(doc, /caffeinate/);
  assert.match(doc, /pmset/);
  assert.match(doc, /sudo pmset -c sleep 0/);
  assert.match(doc, /Closing the lid/);
  assert.match(doc, /Logging out/);
  assert.match(doc, /NOT-369/);
});
