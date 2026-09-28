// NOT-287: the Issues home shows one compact first-issue strip only for a
// truly fresh, unfiltered, undismissed history — never for a filtered-empty
// list — and collapses empty admission chrome to a quiet status line while
// real entries keep the full panel. Effects never run under
// renderToStaticMarkup, so the state matrix itself lives in
// lib/firstIssue.test.ts; these tests pin the initial markup (no onboarding
// flash, no idle chrome) plus the source wiring that drives it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import type { AgentWithHealth } from "@agent-dealer/shared";
// node --import tsx compiles JSX in classic mode: components reference the
// React global at render time.
(globalThis as { React?: unknown }).React ??= React;

register("../test-helpers/asset-stub-hooks.mjs", import.meta.url);

const { renderToStaticMarkup } = await import("react-dom/server");
const { MemoryRouter } = await import("react-router-dom");
const { default: IssuesListPage } = await import("./IssuesListPage.js");
const { default: FirstIssueStrip } = await import("../components/issues/FirstIssueStrip.js");

const dir = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(join(dir, "IssuesListPage.tsx"), "utf8");
const stripSource = readFileSync(
  join(dir, "..", "components", "issues", "FirstIssueStrip.tsx"),
  "utf8"
);
const apiSource = readFileSync(join(dir, "..", "api.ts"), "utf8");

function renderPage(entry: string): string {
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: [entry] },
      React.createElement(IssuesListPage, {
        agents: [],
        humanActions: [],
        onHumanActionsChanged: () => {},
      })
    )
  );
}

function seedAgent(extra: Partial<AgentWithHealth> = {}): AgentWithHealth {
  return {
    id: "00000000-0000-4000-a000-000000000001",
    name: "Claude",
    runtime: "claude_code",
    workspaceRoot: null,
    deckId: null,
    deckName: null,
    playbookId: null,
    defaultPlanModel: null,
    defaultExecuteModel: null,
    defaultPlanBudgetJson: null,
    defaultExecuteBudgetJson: null,
    defaultModel: null,
    defaultEffort: null,
    defaultBudgetJson: null,
    purpose: null,
    playbookIdsJson: null,
    externalMemoryRefsJson: null,
    permissionPolicyJson: null,
    isBuiltin: false,
    createdAt: "2026-09-20T09:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z",
    healthy: false,
    issues: [
      {
        code: "deck_missing",
        message: "Set an Agent Deck on the Agents page — workers never start without one",
      },
    ],
    ...extra,
  };
}

/** Fresh-install rows from seedBuiltinAgents: three agents, no deck, unhealthy. */
function freshSeedAgents(): AgentWithHealth[] {
  return [
    seedAgent({ name: "Claude", runtime: "claude_code" }),
    seedAgent({
      id: "00000000-0000-4000-a000-000000000002",
      name: "Cursor",
      runtime: "cursor_local",
    }),
    seedAgent({
      id: "00000000-0000-4000-a000-000000000003",
      name: "Codex",
      runtime: "codex_local",
    }),
  ];
}

function healthyAgent(extra: Partial<AgentWithHealth> = {}): AgentWithHealth {
  return seedAgent({
    id: "11111111-1111-4111-8111-111111111111",
    name: "Cursor Dev",
    runtime: "cursor_local",
    deckId: "11111111-1111-4111-8111-111111111111",
    deckName: "Deck",
    healthy: true,
    issues: [],
    ...extra,
  });
}

function renderStrip(agents: AgentWithHealth[]): string {
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: ["/issues"] },
      React.createElement(FirstIssueStrip, {
        agents,
        onStartIssue: () => {},
        onDismiss: () => {},
      })
    )
  );
}

test("fresh home does not flash the strip before history loads", () => {
  const html = renderPage("/issues");
  assert.ok(
    !html.includes('data-testid="first-issue-strip"'),
    "strip stays hidden while the history count loads"
  );
  assert.ok(html.includes("New issue"), "normal New issue control stays available");
});

test("filtered-empty list never renders onboarding", () => {
  const html = renderPage("/issues?q=no-such-issue");
  assert.ok(
    !html.includes('data-testid="first-issue-strip"'),
    "a filter that matches nothing shows no first-run strip"
  );
  assert.ok(
    html.includes('data-testid="filters-active-indicator"'),
    "the filtered state still marks itself as filtered"
  );
});

test("no idle admission chrome on the first screen", () => {
  const html = renderPage("/issues");
  assert.ok(
    !html.includes('data-testid="admission-idle-status"'),
    "no admission status line before admission loads"
  );
  assert.ok(!html.includes("Admission queue"), "no queue panel with no entries");
});

test("strip gate trusts only unfiltered history, never the filtered list", () => {
  assert.ok(
    pageSource.includes("shouldShowFirstIssueStrip({"),
    "strip renders through the fresh-history predicate"
  );
  assert.ok(pageSource.includes("filtersActive"), "active filters veto the strip");
  assert.ok(pageSource.includes("firstIssueDismissed"), "dismissal vetoes the strip");
  assert.ok(pageSource.includes("historyTotal"), "history count feeds the strip");
  assert.ok(
    pageSource.includes("fetchIssuesHistoryTotal([...ISSUE_STATUS_OPTIONS])"),
    "history fetch names every status so closed rows count"
  );
  assert.ok(
    !/showFirstIssue\s*=\s*[^;]*issuePage\.total/.test(pageSource),
    "the filtered list total never decides the strip"
  );
});

test("dismissal persists per local profile and creating removes the strip", () => {
  assert.ok(pageSource.includes("FIRST_ISSUE_DISMISS_KEY") || pageSource.includes("dismissFirstIssue"), "dismiss writes local storage");
  assert.ok(pageSource.includes("isFirstIssueDismissed()"), "dismissal is read on load");
  assert.ok(pageSource.includes("onDismiss={dismissStrip}"), "strip dismiss is wired");
  assert.ok(pageSource.includes("refreshHistory()"), "refresh re-reads history");
  assert.ok(
    /const refresh = \(\) => \{[\s\S]*?refreshHistory\(\);/.test(pageSource),
    "the shared refresh (create path) updates history so the first issue retires the strip"
  );
  assert.ok(
    /await createIssue\([\s\S]*?refresh\(\);/.test(pageSource),
    "creating an issue runs the shared refresh"
  );
});

test("next step routes to Agents when empty, New issue once configured", () => {
  const noAgents = renderStrip([]);
  assert.ok(noAgents.includes('href="/agents"'), "no agents → primary action goes to Agents");
  assert.ok(noAgents.includes("Configure agents"), "agents step labels its action");
  const withAgents = renderStrip([healthyAgent()]);
  assert.ok(withAgents.includes('data-testid="first-issue-primary"'), "primary action present");
  assert.ok(!withAgents.includes('href="/agents"'), "configured agents → primary starts the issue, not Agents");
});

test("fresh seeded agents (no deck) still route to Agents", () => {
  // seedBuiltinAgents inserts three unconfigured rows on every fresh install —
  // row count alone must not send them to New issue.
  const html = renderStrip(freshSeedAgents());
  assert.ok(html.includes('href="/agents"'), "seeded no-deck agents → primary action goes to Agents");
  assert.ok(html.includes("Configure agents"), "agents step labels its action");
});

test("strip copy names the smallest path and never blocks on capacity", () => {
  const html = renderStrip([]);
  assert.ok(html.includes("Create your first issue"), "compact title");
  assert.ok(html.includes("GitHub repository"), "repository step named");
  assert.ok(html.includes("developer") && html.includes("reviewer"), "agent steps named");
  assert.ok(
    html.includes("never") && html.includes("blocks creating an issue"),
    "copy disclaims capacity as a blocker"
  );
  assert.ok(
    !/capacit[^.]*requir/i.test(stripSource),
    "strip never frames capacity as a requirement"
  );
  assert.ok(
    html.includes('aria-label="Dismiss first-issue guide"'),
    "dismiss control is accessible"
  );
});

test("history helper counts the full cohort, closed included", () => {
  assert.ok(apiSource.includes("fetchIssuesHistoryTotal"), "history helper exists");
  assert.ok(
    apiSource.includes('qs.set("limit", "1")'),
    "history read stays a one-row payload"
  );
  assert.ok(
    apiSource.includes("typeof json.total"),
    "helper returns the cohort total, not the rows"
  );
});

test("empty admission collapses to a status line; real entries keep the panel", () => {
  assert.ok(pageSource.includes("queue.length > 0 ? ("), "full panel requires entries");
  assert.ok(pageSource.includes('data-testid="admission-idle-status"'), "idle state is one muted line");
  assert.ok(pageSource.includes(">Admission queue<"), "full panel title kept for real entries");
  assert.ok(pageSource.includes("changeLimit"), "limit control stays functional");
  assert.ok(pageSource.includes("<NeedsAttentionPanel"), "attention panel untouched");
  assert.ok(
    !/admission-idle-status[\s\S]{0,400}border-red/.test(pageSource),
    "idle line carries no error styling that could read as a failure"
  );
});
