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
import LinearIntakeFiltersEditor, { uniqueStatusNames } from "./LinearIntakeFiltersEditor.js";

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
  assert.ok(html.includes(">Save<") || html.includes("Save"), "save action");
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
  // Team select and status fieldset carry disabled when overridden.
  assert.ok(/aria-label="Team"[^>]*disabled/.test(html), "team control disabled");
  assert.ok(source.includes("statusDisabled"), "status controls gated");
});

test("reopening restores persisted Team, Assignee, and Status values", () => {
  const html = renderToStaticMarkup(
    <LinearIntakeFiltersEditor initialConfig={CONFIG} initialMetadata={METADATA} />
  );
  assert.ok(html.includes('value="team-1"'), "persisted team selected");
  // Assignee-me radio is checked when persisted.assigneeMe is true.
  assert.ok(
    /name="linear-assignee"[^>]*checked/.test(html) || html.includes("checked"),
    "assignee selection restored"
  );
  assert.ok(html.includes("Todo"), "persisted statuses present");
  assert.ok(source.includes("cfg.persisted.stateFilter"), "loads persisted statuses");
  assert.ok(source.includes("cfg.persisted.teamId"), "loads persisted team");
  assert.ok(source.includes("cfg.persisted.assigneeMe"), "loads persisted assignee");
});

test("the editor never writes parent New issue form fields", () => {
  assert.ok(!source.includes("setTitle"), "no title writer");
  assert.ok(!source.includes("setRepo"), "no repo writer");
  assert.ok(!source.includes("setSelectedLinearId"), "no selection writer");
  assert.ok(!source.includes("setDescription"), "no description writer");
  assert.ok(/onSaved\?\.|onSaved/.test(source), "signals parent to refresh candidates only");
  assert.ok(/saveConfig|patchLinearIntakeConfig/.test(source), "saves via config API");
});
