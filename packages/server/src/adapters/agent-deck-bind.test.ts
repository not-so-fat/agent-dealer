// packages/server/src/adapters/agent-deck-bind.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { bindAndVerify, parseDeckToolResult, type DeckToolCaller } from "./agent-deck-bind.js";

const DECK = "7eb62206-f3a3-44d1-99e5-8f40b39be084";
const WT = "/tmp/worktrees/session-a-developer";

function caller(handlers: Record<string, (args: Record<string, unknown>) => unknown>): DeckToolCaller {
  return async (name, args) => {
    const h = handlers[name];
    if (!h) throw new Error(`unexpected tool ${name}`);
    return h(args);
  };
}

function textResult(obj: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

function errorResult(msg: string) {
  return { isError: true, content: [{ type: "text", text: msg }] };
}

test("parseDeckToolResult extracts and parses the text payload", () => {
  assert.deepEqual(parseDeckToolResult(textResult({ a: 1 })), { a: 1 });
  assert.throws(() => parseDeckToolResult({ content: [] }));
});

test("bindAndVerify succeeds when the effective binding matches", async () => {
  const result = await bindAndVerify({
    deckId: DECK,
    worktreePath: WT,
    callTool: caller({
      bind_workspace: () => textResult({ ok: true }),
      get_session_binding: () =>
        textResult({ effective_deck_id: DECK, display_summary: "◆ personal-dev" }),
    }),
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.effectiveDeckId, DECK);
});

test("bindAndVerify returns a structured failure on a deck mismatch (no throw)", async () => {
  const result = await bindAndVerify({
    deckId: DECK,
    worktreePath: WT,
    callTool: caller({
      bind_workspace: () => textResult({ ok: true }),
      get_session_binding: () => textResult({ effective_deck_id: "some-other-deck" }),
    }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /does not match/);
});

test("bindAndVerify returns a structured failure when the workspace does not match (camelCase field)", async () => {
  const result = await bindAndVerify({
    deckId: DECK,
    worktreePath: WT,
    callTool: caller({
      bind_workspace: () => textResult({ ok: true }),
      get_session_binding: () =>
        textResult({ effective_deck_id: DECK, workspaceRoot: "/somewhere/else" }),
    }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /workspace/);
});

test("bindAndVerify rejects an isError result from bind_workspace even with a matching binding", async () => {
  const result = await bindAndVerify({
    deckId: DECK,
    worktreePath: WT,
    callTool: caller({
      bind_workspace: () => errorResult("grant expired"),
      get_session_binding: () => textResult({ effective_deck_id: DECK, workspaceRoot: WT }),
    }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /bind_workspace returned an error/);
});

test("bindAndVerify rejects an isError result from get_session_binding", async () => {
  const result = await bindAndVerify({
    deckId: DECK,
    worktreePath: WT,
    callTool: caller({
      bind_workspace: () => textResult({ ok: true }),
      get_session_binding: () => errorResult("no session"),
    }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /get_session_binding returned an error/);
});

test("bindAndVerify surfaces a bind_workspace failure as a reason", async () => {
  const result = await bindAndVerify({
    deckId: DECK,
    worktreePath: WT,
    callTool: caller({
      bind_workspace: () => {
        throw new Error("No valid workspace grant");
      },
    }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /No valid workspace grant/);
});
