// packages/server/src/coordinator/deck-scope-guidance.test.ts
//
// NOT-232: dealer workers must never infer "deck X does not exist" from a deck
// listing. The `get_decks` / `bind_workspace` / `switch_deck` tool definitions live
// in the separate Agent Deck repo (not this checkout), so what this repo owns is
// its generated worker guidance plus the worker tool surface: prompts must never
// instruct deck discovery, and no worker allowlist may grant a deck-enumeration
// tool (containment unchanged).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeveloperPrompt, buildReviewerPrompt } from "./prompts.js";
import { AGENT_DECK_READ_TOOLS } from "../runners/muse-config-core.js";
import { CODEX_DECK_READ_TOOLS } from "../adapters/codex-scoped-config.js";
import { buildDeveloperArgs } from "./args.js";

const taskSnapshot = {
  title: "Add widget",
  description: "Build the widget.",
  acceptanceCriteria: "Widget renders.",
  repo: "acme/app",
  baseBranch: "main",
};

const reviewerBase = {
  taskSnapshot,
  round: 1,
  baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  diff: "diff --git a/x b/x\n+added line\n",
};

/** Any phrasing that would tell a worker the session can enumerate decks. */
const DECK_DISCOVERY = /get_decks|all decks|list .*decks|available decks|verify .*decks/i;

test("NOT-232: developer deck guidance never instructs deck discovery and states the fixed-scope rule", () => {
  const prompt = buildDeveloperPrompt({ taskSnapshot, round: 1, worktreePath: "/wt", deckId: "deck-a" });
  assert.doesNotMatch(prompt, DECK_DISCOVERY);
  assert.match(prompt, /fixed at launch/);
  assert.match(prompt, /no deck-listing tool/);
  assert.match(prompt, /never infer that another deck does not exist/);
});

test("NOT-232: reviewer deck guidance never instructs deck discovery and states the fixed-scope rule", () => {
  const prompt = buildReviewerPrompt({ ...reviewerBase, worktreePath: "/wt", deckId: "deck-a" });
  assert.doesNotMatch(prompt, DECK_DISCOVERY);
  assert.match(prompt, /fixed at launch/);
  assert.match(prompt, /never infer that another deck does not exist/);
});

test("NOT-232: deckless and no-Agent-Deck prompts contain no deck-discovery instruction either", () => {
  const misconfigured = buildDeveloperPrompt({ taskSnapshot, round: 1, deckId: null });
  assert.doesNotMatch(misconfigured, DECK_DISCOVERY);
  const noDeck = buildDeveloperPrompt({ taskSnapshot, round: 1, noAgentDeck: true, deckId: null, worktreePath: "/wt" });
  assert.doesNotMatch(noDeck, DECK_DISCOVERY);
});

// Containment unchanged: no worker tool surface grants deck enumeration.
// Must hold before and after any guidance rewording.
test("NOT-232: worker deck tool allowlists grant no enumeration tool", () => {
  for (const tools of [AGENT_DECK_READ_TOOLS, CODEX_DECK_READ_TOOLS]) {
    assert.ok(!tools.includes("get_decks" as never), `allowlist grants get_decks: ${tools.join(",")}`);
    assert.ok(!tools.includes("switch_deck" as never), `allowlist grants switch_deck: ${tools.join(",")}`);
  }
  const args = buildDeveloperArgs("claude_code", "implement");
  const allowed = args[args.indexOf("--allowedTools") + 1];
  assert.doesNotMatch(allowed, /get_decks/);
  assert.doesNotMatch(allowed, /switch_deck/);
});
