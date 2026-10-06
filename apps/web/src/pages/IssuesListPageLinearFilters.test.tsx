// NOT-361: New issue → From Linear inline filter gear, hasMore copy, and
// form-preservation wiring. Effects do not run under renderToStaticMarkup, so
// the editor markup is asserted via LinearIntakeFiltersEditor.test.tsx; this
// file pins point-of-use placement on the page and the regression contracts
// that keep New issue fields intact across open/save/close/lookup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
(globalThis as { React?: unknown }).React ??= React;
import { renderToStaticMarkup } from "react-dom/server";
import type { LinearIntakeConfigView, LinearIntakeMetadata } from "@agent-dealer/shared";
import LinearIntakeFiltersEditor from "../components/issues/LinearIntakeFiltersEditor.js";

const dir = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(join(dir, "IssuesListPage.tsx"), "utf8");
const editorSource = readFileSync(
  join(dir, "..", "components", "issues", "LinearIntakeFiltersEditor.tsx"),
  "utf8"
);

const CONFIG: LinearIntakeConfigView = {
  stateFilter: ["Todo"],
  teamId: null,
  assigneeMe: false,
  persisted: { stateFilter: ["Todo"], teamId: null, assigneeMe: false },
  envOverrides: { stateFilter: false, teamId: false },
};

const METADATA: LinearIntakeMetadata = {
  teams: [{ id: "t1", name: "Core", key: "COR" }],
  workflowStates: [{ name: "Todo", type: "unstarted", teamId: "t1" }],
  viewer: { id: "v1", name: "Ada" },
};

test("From Linear renders an accessible gear adjacent to the open-inbox picker", () => {
  assert.ok(
    pageSource.includes('aria-label="Configure Linear intake filters"'),
    "gear has accessible label"
  );
  assert.ok(
    pageSource.includes('title="Configure Linear intake filters"'),
    "gear has title"
  );
  assert.ok(pageSource.includes("Or pick from open inbox…"), "inbox label present");
  assert.ok(pageSource.includes("LinearIntakeFiltersEditor"), "inline editor mounted");
  assert.ok(pageSource.includes("linearFiltersOpen"), "gear toggles editor");
  // Gear sits in the same label row as the open-inbox copy (point-of-use).
  const block = pageSource.match(
    /Or pick from open inbox[\s\S]{0,400}?Configure Linear intake filters/
  );
  assert.ok(block, "gear is adjacent to the open-inbox label");
});

test("opening the editor shows Team, Assignee, and Status with display names", () => {
  const html = renderToStaticMarkup(
    <LinearIntakeFiltersEditor initialConfig={CONFIG} initialMetadata={METADATA} />
  );
  assert.ok(html.includes('aria-label="Team"'));
  assert.ok(html.includes("Core"));
  assert.ok(html.includes("Anyone"));
  assert.ok(html.includes("Assigned to me"));
  assert.ok(html.includes("Status"));
  assert.ok(html.includes("Todo"));
});

test("hasMore true shows the 50-result bound and points at ID/URL lookup", () => {
  assert.ok(
    pageSource.includes('data-testid="linear-candidates-has-more"'),
    "hasMore notice slot"
  );
  assert.ok(
    pageSource.includes("50 most recently updated matches"),
    "explains the bound"
  );
  assert.ok(
    pageSource.includes("exact ID/URL lookup"),
    "points at the escape hatch"
  );
  assert.ok(
    /candidatesHasMore && \(/.test(pageSource),
    "notice only when hasMore is true"
  );
});

test("saving, closing, or reopening filters preserves New issue form state", () => {
  // Seeded form fields the page owns — none of these setters appear in the editor.
  for (const field of [
    "setTitle",
    "setDescription",
    "setAcceptanceCriteria",
    "setRepo",
    "setBaseBranch",
    "setDeveloperAgentId",
    "setReviewerAgentId",
    "setAutoMerge",
    "setSelectedLinearId",
    "setLinearRef",
  ]) {
    assert.ok(!editorSource.includes(field), `editor must not call ${field}`);
  }

  // Gear toggle flips only editor visibility.
  assert.ok(
    pageSource.includes("onClick={() => setLinearFiltersOpen((v) => !v)}"),
    "toggle touches only linearFiltersOpen"
  );
  // Close only hides the editor.
  assert.ok(
    pageSource.includes("onClose={() => setLinearFiltersOpen(false)}"),
    "close only hides editor"
  );
  // Successful save refreshes candidates only.
  assert.ok(
    pageSource.includes("onSaved={refreshLinearCandidates}"),
    "save refreshes candidates"
  );
  assert.ok(
    pageSource.includes("mergeLinearCandidatePage"),
    "refresh preserves selected candidate"
  );
});

test("exact lookup inserts an out-of-filter issue without altering saved filters", () => {
  assert.ok(
    pageSource.includes("insertLookedUpLinearCandidate"),
    "lookup uses insert helper"
  );
  assert.ok(
    pageSource.includes("applyLinearCandidate"),
    "lookup applies candidate into the picker"
  );
  // Lookup path never patches filter config.
  assert.ok(
    !pageSource.includes("patchLinearIntakeConfig"),
    "page does not rewrite filters on lookup"
  );
  assert.ok(
    pageSource.includes("lookupLinearIssue"),
    "exact ID/URL lookup retained"
  );
});
