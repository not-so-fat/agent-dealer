// NOT-227: pins the shell identity and primary nav order (Issues before
// Reports). NOT-231: product copy is AgentDealer; Monaco is only the
// wordmark font (font-mono token), not replacement copy. ShellHeader is
// pure, so renderToStaticMarkup under MemoryRouter pins the markup without
// a browser.
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

function wordmarkClass(html: string): string {
  const match = html.match(/<h1[^>]*class="([^"]*)"[^>]*>AgentDealer</);
  assert.ok(match, "wordmark h1 renders AgentDealer with a class attribute");
  return match[1];
}

test("wordmark is exactly AgentDealer and links to /issues", () => {
  const html = render();
  assert.ok(html.includes(">AgentDealer<"), "visible wordmark reads AgentDealer");
  assert.ok(!html.includes(">Monaco<"), "Monaco is not product copy");
  assert.ok(!html.includes("Monaco"), "Monaco appears nowhere in shell markup");
  assert.ok(
    html.includes('aria-label="AgentDealer — go to Issues"'),
    "header link accessible name uses AgentDealer"
  );
  assert.ok(
    html.includes('title="AgentDealer — go to Issues"'),
    "header link title uses AgentDealer"
  );
  assert.ok(html.includes('href="/issues"'), "wordmark still navigates to /issues");
});

test("wordmark renders through the Monaco-backed font-mono token", () => {
  const html = render();
  const cls = wordmarkClass(html);
  assert.ok(
    cls.split(/\s+/).includes("font-mono"),
    `wordmark uses the Monaco-backed font-mono token (got: ${cls})`
  );
  assert.ok(!cls.includes("font-ui-display"), "wordmark does not use the Avenir-backed token");
  const h1Tag = html.slice(html.lastIndexOf("<h1", html.indexOf(">AgentDealer<")), html.indexOf(">AgentDealer<"));
  assert.ok(!/font-family/i.test(h1Tag), "wordmark does not hard-code a font family");
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
