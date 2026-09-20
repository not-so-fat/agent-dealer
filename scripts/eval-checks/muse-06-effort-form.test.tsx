// Eval-owned check for muse-06 (NOT-176), copied into apps/web/src/ at verification time. The web app
// has no test runner, so this renders the real AgentConfigFields to static markup and inspects
// AgentsPage's source with the TypeScript compiler API. It covers what the worker's held-out server/shared
// tests cannot: that the Agents form exposes the effort selector and carries the value into requests.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import AgentConfigFields from "./AgentConfigFields";

const base = {
  runtime: "claude_code",
  deckId: "",
  playbookId: "",
  purpose: "",
  defaultModel: "",
  defaultEffort: "",
  defaultBudget: { maxTurns: "", maxUsd: "" },
  playbookIds: [],
  externalMemoryRefs: "",
} as const;

function render(patch: Record<string, unknown>): string {
  const props = { value: { ...base, ...patch }, onChange: () => {}, agentDeckOnline: false, disabled: false };
  return renderToStaticMarkup(createElement(AgentConfigFields as never, props as never));
}

const effortSelect = (html: string) => html.match(/Reasoning effort[\s\S]*?<\/select>/)?.[0] ?? null;

test("effort selector is shown for codex/claude with low/medium/high and a clearing 'runtime default' option", () => {
  for (const runtime of ["claude_code", "codex_local"]) {
    const sel = effortSelect(render({ runtime }));
    assert.ok(sel, `${runtime}: effort selector rendered`);
    for (const v of ["", "low", "medium", "high"]) assert.match(sel!, new RegExp(`<option value="${v}"`), `${runtime}: option ${JSON.stringify(v)}`);
  }
});

test("the selector reflects the current value, including cleared", () => {
  assert.match(effortSelect(render({ defaultEffort: "high" }))!, /<option value="high" selected/);
  assert.match(effortSelect(render({ defaultEffort: "" }))!, /<option value="" selected/);
});

test("cursor has no effort selector", () => {
  assert.equal(effortSelect(render({ runtime: "cursor_local" })), null);
});

test("AgentsPage seeds, loads and submits defaultEffort in create and update requests", () => {
  const file = "src/pages/AgentsPage.tsx";
  const src = ts.createSourceFile(file, fs.readFileSync(new URL(`./pages/AgentsPage.tsx`, import.meta.url), "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const hits: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n) && n.name.getText(src) === "defaultEffort") hits.push(n.initializer.getText(src));
    ts.forEachChild(n, visit);
  };
  visit(src);
  // emptyConfig seed, edit-form load, create payload, update payload.
  assert.ok(hits.includes('""'), `empty seed present (${hits.join(" | ")})`);
  assert.ok(hits.some((h) => /agent\.defaultEffort/.test(h)), "edit form loads the stored effort");
  assert.equal(hits.filter((h) => /\|\|\s*null/.test(h)).length >= 2, true, "create and update send effort, empty string as null (clear)");
});
