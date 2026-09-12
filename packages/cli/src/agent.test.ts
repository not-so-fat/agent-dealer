import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentCommand } from "./agent.js";
import { stubFetch } from "./test-fetch-stub.js";

test("agent list calls GET /api/agents and exits 0", async () => {
  const stub = stubFetch("/api/agents", "GET", { agents: [], issueCount: 0 });
  try {
    const code = await runAgentCommand(["list"]);
    assert.equal(code, 0);
    stub.assertCalled();
  } finally {
    stub.restore();
  }
});

test("unknown agent subcommand returns nonzero", async () => {
  const code = await runAgentCommand(["bogus"]);
  assert.equal(code, 1);
});
