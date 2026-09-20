// Eval-owned check for muse-06 (NOT-176), copied into apps/web/src/ at verification time. The web app
// has no test runner, so this renders the real AgentConfigFields to static markup and inspects
// AgentsPage's source with the TypeScript compiler API. It covers what the worker's held-out server/shared
// tests cannot: that the Agents form exposes the effort selector and carries the value into requests.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as React from "react";
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

// AgentConfigFields uses hooks, so it cannot be called outside a render. Give it a stub dispatcher (state
// returns its initial value, effects never run) and read the returned element tree: this reaches the real
// onChange handler of the effort <select> without a DOM.
type El = { type: unknown; props: { children?: unknown; [k: string]: unknown } };
function selectsIn(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => selectsIn(n, out));
  else if (node && typeof node === "object" && "props" in node) {
    const el = node as El;
    if (el.type === "select") out.push(el);
    selectsIn(el.props.children, out);
  }
  return out;
}

function effortOnChange(patch: Record<string, unknown>) {
  const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const emitted: Array<Record<string, unknown>> = [];
  const value = { ...base, ...patch };
  const previous = internals.H;
  internals.H = { useState: (init: unknown) => [typeof init === "function" ? (init as () => unknown)() : init, () => {}], useEffect: () => {} };
  let tree: unknown;
  try {
    tree = (AgentConfigFields as unknown as (p: unknown) => unknown)({ value, onChange: (v: Record<string, unknown>) => emitted.push(v), agentDeckOnline: false, disabled: false });
  } finally {
    internals.H = previous;
  }
  const effort = selectsIn(tree).filter((s) => JSON.stringify(s.props.children).includes('"low"'));
  return { value, emitted, select: effort.length === 1 ? effort[0] : null };
}

test("choosing each effort in the selector emits the updated config, including the empty clearing value", () => {
  for (const runtime of ["claude_code", "codex_local"]) {
    for (const chosen of ["low", "medium", "high", ""]) {
      // Start from a different value so the assertion cannot pass by echoing the current one.
      const start = chosen === "high" ? "low" : "high";
      const { value, emitted, select } = effortOnChange({ runtime, defaultEffort: start });
      assert.ok(select, `${runtime}: exactly one effort select in the element tree`);
      const handler = select!.props.onChange as ((e: unknown) => void) | undefined;
      assert.equal(typeof handler, "function", `${runtime}: effort select has an onChange handler`);
      handler!({ target: { value: chosen } });
      assert.equal(emitted.length, 1, `${runtime}/${JSON.stringify(chosen)}: onChange called once`);
      assert.deepEqual(emitted[0], { ...value, defaultEffort: chosen }, `${runtime}/${JSON.stringify(chosen)}: emits the full config with the chosen effort`);
    }
  }
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
