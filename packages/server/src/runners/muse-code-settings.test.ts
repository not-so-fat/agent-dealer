import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMuseDeveloperSettings } from "./muse-code-settings.js";

// NOT-181: the per-attempt settings are the NOT-177 recommended template minus `mcpServers`, so the
// two cannot drift apart silently.
test("developer settings equal the recommended NOT-177 template without its MCP block", () => {
  const template = JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "fixtures", "muse-code", "settings", "recommended.settings.template.json"),
      "utf8"
    )
  ) as Record<string, unknown>;
  delete template.mcpServers;
  assert.deepEqual(buildMuseDeveloperSettings(), template);
});

test("developer settings switch workflows and subagents off and configure no MCP server", () => {
  const settings = buildMuseDeveloperSettings();
  assert.deepEqual(settings.run, { workflow_trigger_mode: "off", subagent_delegation_mode: "off" });
  assert.equal("mcpServers" in settings, false);
});
