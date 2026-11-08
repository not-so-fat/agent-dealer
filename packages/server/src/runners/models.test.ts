import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { listRuntimeModels } from "./models.js";

test("listRuntimeModels codex_local returns fallback when no models_cache.json", async () => {
  const oldHome = process.env.HOME;
  // Point HOME at a dir that definitely has no ~/.codex/models_cache.json
  process.env.HOME = os.tmpdir();
  try {
    const result = await listRuntimeModels("codex_local", { refresh: true });
    assert.equal(result.source, "fallback");
    assert.ok(result.models.length > 0, "fallback models present");
    assert.ok(
      result.models.some((m) => m.id === "gpt-5.6-sol"),
      "fallback includes gpt-5.6-sol"
    );
  } finally {
    if (oldHome !== undefined) process.env.HOME = oldHome;
    else delete process.env.HOME;
  }
});

test("listRuntimeModels claude_code returns fallback when ANTHROPIC_API_KEY is unset", async () => {
  const oldKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const result = await listRuntimeModels("claude_code", { refresh: true });
    assert.equal(result.source, "fallback");
    assert.ok(result.models.length > 0, "fallback models present");
    assert.ok(
      result.models.some((m) => m.id === "sonnet"),
      "fallback includes sonnet alias"
    );
  } finally {
    if (oldKey !== undefined) process.env.ANTHROPIC_API_KEY = oldKey;
  }
});

test("listRuntimeModels uses cache on second call without refresh", async () => {
  const oldHome = process.env.HOME;
  process.env.HOME = os.tmpdir();
  try {
    // Prime the cache
    const first = await listRuntimeModels("codex_local", { refresh: true });
    // Second call without refresh — must serve from cache (same reference shape)
    const second = await listRuntimeModels("codex_local");
    assert.equal(second.source, first.source);
    assert.deepEqual(
      second.models.map((m) => m.id),
      first.models.map((m) => m.id)
    );
  } finally {
    if (oldHome !== undefined) process.env.HOME = oldHome;
    else delete process.env.HOME;
  }
});
