import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexModelsCache } from "./models.js";

test("parseCodexModelsCache keeps visibility=list and drops hide", () => {
  const models = parseCodexModelsCache({
    models: [
      { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide" },
      { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list" },
      { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide" },
      { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", visibility: "list" },
    ],
  });
  assert.deepEqual(
    models.map((m) => m.id),
    ["gpt-5.6-sol", "gpt-5.6-terra"]
  );
});
