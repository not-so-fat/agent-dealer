// NOT-361: inline Linear intake filters editor — Team / Assignee / Status with
// display names, env-override notices, and save that never touches New issue fields.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
(globalThis as { React?: unknown }).React ??= React;
import { renderToStaticMarkup } from "react-dom/server";
import type { LinearIntakeConfigView, LinearIntakeMetadata } from "@agent-dealer/shared";
import LinearIntakeFiltersEditor, {
  canSaveLinearIntakeFilters,
  pruneStatusesToOptions,
  uniqueStatusNames,
} from "./LinearIntakeFiltersEditor.js";

const dir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(dir, "LinearIntakeFiltersEditor.tsx"), "utf8");

const CONFIG: LinearIntakeConfigView = {
  stateFilter: ["Todo", "In Progress"],
  teamId: "team-1",
  assigneeMe: true,
  persisted: {
    stateFilter: ["Todo", "In Progress"],
    teamId: "team-1",
    assigneeMe: true,
  },
  envOverrides: { stateFilter: false, teamId: false },
};

const METADATA: LinearIntakeMetadata = {
  teams: [
    { id: "team-1", name: "Core", key: "COR" },
    { id: "team-2", name: "Platform", key: "PLA" },
  ],
  workflowStates: [
    { name: "Todo", type: "unstarted", teamId: "team-1" },
    { name: "In Progress", type: "started", teamId: "team-1" },
    { name: "Todo", type: "unstarted", teamId: "team-2" },
    { name: "Done", type: "completed", teamId: "team-2" },
  ],
  viewer: { id: "v1", name: "Ada" },
};

test("uniqueStatusNames dedupes across teams and scopes to one team", () => {
  assert.deepEqual(uniqueStatusNames(METADATA.workflowStates, null), [
    "Todo",
    "In Progress",
    "Done",
  ]);
  assert.deepEqual(uniqueStatusNames(METADATA.workflowStates, "team-1"), [
    "Todo",
    "In Progress",
  ]);
});

test("pruneStatusesToOptions drops names not shown for the current team", () => {
  assert.deepEqual(
    pruneStatusesToOptions(["Todo", "Done", "In Progress"], ["Todo", "In Progress"]),
    ["Todo", "In Progress"]
  );
  assert.deepEqual(
    pruneStatusesToOptions(["Todo"], []),
    ["Todo"],
    "empty options preserve selection (metadata gap)"
  );
});

test("canSaveLinearIntakeFilters requires a loaded config view", () => {
  assert.equal(canSaveLinearIntakeFilters(null, false), false);
  assert.equal(canSaveLinearIntakeFilters(CONFIG, true), false);
  assert.equal(canSaveLinearIntakeFilters(CONFIG, false), true);
});

test("editor renders Team, Assignee, and Status controls with display names", () => {
  const html = renderToStaticMarkup(
    <LinearIntakeFiltersEditor initialConfig={CONFIG} initialMetadata={METADATA} />
  );
  assert.ok(html.includes('aria-label="Linear intake filters"'), "point-of-use region");
  assert.ok(html.includes('aria-label="Team"'), "Team control labeled");
  assert.ok(html.includes("All teams"), "All teams option");
  assert.ok(html.includes("Core"), "team display name");
  assert.ok(html.includes("Anyone"), "Anyone assignee");
  assert.ok(html.includes("Assigned to me"), "Assigned to me");
  assert.ok(html.includes("Ada"), "viewer name shown");
  assert.ok(html.includes("Status"), "Status legend");
  assert.ok(html.includes("Todo"), "status display name");
  assert.ok(html.includes("In Progress"), "status display name");
  assert.ok(!html.includes("comma-separated"), "no CSV status entry");
  assert.ok(html.includes('data-testid="linear-filters-save"'), "save action");
});

test("env overrides disable only the affected controls and explain why", () => {
  const overridden: LinearIntakeConfigView = {
    ...CONFIG,
    stateFilter: ["In Review"],
    teamId: "env-team",
    envOverrides: { stateFilter: true, teamId: true },
  };
  const html = renderToStaticMarkup(
    <LinearIntakeFiltersEditor initialConfig={overridden} initialMetadata={METADATA} />
  );
  assert.ok(html.includes('data-testid="linear-filter-env-notice"'), "override notice");
  assert.ok(html.includes("LINEAR_TEAM_ID"), "names team env");
  assert.ok(html.includes("LINEAR_STATE_FILTER"), "names status env");
  assert.ok(/aria-label="Team"[^>]*disabled/.test(html), "team control disabled");
  // Status checkboxes themselves carry disabled (not only a source-name grep).
  assert.ok(
    /aria-label="Status Todo"[^>]*disabled/.test(html) ||
      /disabled[^>]*aria-label="Status Todo"/.test(html),
    "status checkbox disabled when env overrides status"
  );
});

test("reopening restores persisted Team, Assignee, and Status values", () => {
  const html = renderToStaticMarkup(
    <LinearIntakeFiltersEditor initialConfig={CONFIG} initialMetadata={METADATA} />
  );
  assert.ok(html.includes('value="team-1"'), "persisted team selected");
  // Assigned-to-me is the second radio; with assigneeMe true it must be checked.
  const assigneeRadios = [
    ...html.matchAll(
      /name="linear-assignee"[^>]*?(?:checked)?[^>]*?(?:checked)?/g
    ),
  ];
  assert.ok(assigneeRadios.length >= 2, "both assignee radios rendered");
  assert.ok(
    /name="linear-assignee"[^>]*checked[^>]*>[\s\S]*?Assigned to me/.test(html) ||
      /checked[\s\S]{0,80}Assigned to me/.test(html),
    "Assigned to me radio is checked from persisted assigneeMe"
  );
  assert.ok(
    /aria-label="Status Todo"[^>]*checked/.test(html) ||
      /checked[^>]*aria-label="Status Todo"/.test(html),
    "Todo status checkbox checked from persisted stateFilter"
  );
  assert.ok(
    /aria-label="Status In Progress"[^>]*checked/.test(html) ||
      /checked[^>]*aria-label="Status In Progress"/.test(html),
    "In Progress status checkbox checked from persisted stateFilter"
  );
});

test("config load failure disables Save and does not leave defaults saveable", () => {
  // initialConfig=null pins the failed-load path (effects do not run under SSR).
  const html = renderToStaticMarkup(
    <LinearIntakeFiltersEditor initialConfig={null} initialMetadata={METADATA} />
  );
  assert.ok(html.includes('data-testid="linear-filters-error"'), "shows load error");
  assert.ok(
    /data-testid="linear-filters-save"[^>]*disabled/.test(html) ||
      /disabled[^>]*data-testid="linear-filters-save"/.test(html),
    "Save disabled without a config view"
  );
  assert.equal(canSaveLinearIntakeFilters(null, false), false);
  // Config and metadata must load independently — a metadata rejection must not
  // arm Save with DEFAULT_OPEN_STATES over the operator's persisted filters.
  assert.ok(!source.includes("Promise.all"), "loads are not coupled via Promise.all");
  assert.ok(source.includes("loadConfig()"), "loads config on its own");
  assert.ok(source.includes("loadMetadata()"), "loads metadata on its own");
  assert.ok(
    source.includes("canSaveLinearIntakeFilters(view"),
    "Save gated on config view"
  );
});

test("metadata load failure still allows Save when config view is present", () => {
  const html = renderToStaticMarkup(
    <LinearIntakeFiltersEditor initialConfig={CONFIG} initialMetadata={null} />
  );
  assert.ok(html.includes('data-testid="linear-filters-error"'), "shows metadata error");
  assert.ok(html.includes('data-testid="linear-filters-save"'), "Save button present");
  assert.ok(
    !/data-testid="linear-filters-save"[^>]*\bdisabled\b/.test(html),
    "Save stays enabled when config loaded even if metadata failed"
  );
});

test("the editor never writes parent New issue form fields", () => {
  assert.ok(!source.includes("setTitle"), "no title writer");
  assert.ok(!source.includes("setRepo"), "no repo writer");
  assert.ok(!source.includes("setSelectedLinearId"), "no selection writer");
  assert.ok(!source.includes("setDescription"), "no description writer");
  assert.ok(/onSaved\?\.|onSaved/.test(source), "signals parent to refresh candidates only");
  assert.ok(/saveConfig|patchLinearIntakeConfig/.test(source), "saves via config API");
});
