// NOT-227: pins the shell identity (Monaco wordmark) and primary nav order
// (Issues before Reports). ShellHeader is pure, so renderToStaticMarkup under
// MemoryRouter pins the markup without a browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import React from "react";
// node --import tsx compiles JSX in classic mode: components reference the
// React global at render time.
(globalThis as { React?: unknown }).React ??= React;

// Logo/AgentIcon import image assets that neither Vite (dev-only) nor tsx
// resolves under node:test — stub them before importing the component tree.
register("./test-helpers/asset-stub-hooks.mjs", import.meta.url);

const { renderToStaticMarkup } = await import("react-dom/server");
const { MemoryRouter } = await import("react-router-dom");
const { ShellHeader } = await import("./App.js");

function render(
  props: Parameters<typeof ShellHeader>[0] = {
    openHumanActionCount: 0,
    agentCount: 0,
    agentIssueCount: 0,
  },
  initialEntries: string[] = ["/issues"]
): string {
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries },
      React.createElement(ShellHeader, props)
    )
  );
}

test("wordmark is exactly Monaco and links to /issues", () => {
  const html = render();
  assert.ok(html.includes(">Monaco<"), "visible wordmark reads Monaco");
  assert.ok(!html.includes(">AgentDealer<"), "old wordmark is gone");
  assert.ok(
    html.includes('aria-label="Monaco — go to Issues"'),
    "header link accessible name uses Monaco"
  );
  assert.ok(
    html.includes('title="Monaco — go to Issues"'),
    "header link title uses Monaco"
  );
  assert.ok(html.includes('href="/issues"'), "wordmark still navigates to /issues");
});

test("primary nav orders Issues before Reports, Agents stays separate", () => {
  const html = render();
  const issues = html.indexOf(">Issues");
  const reports = html.indexOf(">Reports<");
  assert.ok(issues !== -1 && reports !== -1, "both nav items render");
  assert.ok(issues < reports, "Issues precedes Reports in DOM order");
  assert.ok(html.includes('href="/reports/execution"'), "Reports route unchanged");
  assert.ok(html.includes('href="/agents"'), "Agents link retained");
  const navBlock = html.slice(html.indexOf("<nav"), html.indexOf("</nav>"));
  assert.ok(!navBlock.includes("/agents"), "Agents stays outside the primary nav");
});

test("attention badge stays attached to Issues with its count and title", () => {
  const html = render(
    { openHumanActionCount: 3, agentCount: 0, agentIssueCount: 0 },
    ["/issues"]
  );
  const issues = html.indexOf(">Issues");
  const reports = html.indexOf(">Reports<");
  const badge = html.indexOf('title="3 open human actions"');
  assert.ok(badge !== -1, "badge keeps its accessible count/title");
  assert.ok(issues < badge && badge < reports, "badge sits inside the Issues link");
  assert.equal(render().indexOf("open human action"), -1, "no badge when none open");
});

test("active-link routing is unchanged per destination", () => {
  const onIssues = render(
    { openHumanActionCount: 0, agentCount: 0, agentIssueCount: 0 },
    ["/issues"]
  );
  assert.ok(
    onIssues.includes('href="/issues"') && onIssues.includes('aria-current="page"'),
    "Issues is active on /issues"
  );
  const onReports = render(
    { openHumanActionCount: 0, agentCount: 0, agentIssueCount: 0 },
    ["/reports/execution"]
  );
  assert.ok(
    onReports.includes('aria-current="page"') && onReports.includes('href="/reports/execution"'),
    "Reports is active on /reports/execution"
  );
  const onAgents = render(
    { openHumanActionCount: 0, agentCount: 0, agentIssueCount: 0 },
    ["/agents"]
  );
  assert.ok(
    onAgents.includes('aria-current="page"') && onAgents.includes('href="/agents"'),
    "Agents is active on /agents"
  );
});

test("shell chrome preserves focus and responsive wrapping affordances", () => {
  const html = render();
  assert.ok(html.includes("flex-wrap"), "header wraps on narrow widths");
  assert.ok(html.includes("focus-visible:"), "wordmark link shows a focus ring");
});
