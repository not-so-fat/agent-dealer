// NOT-385: rendered semantics of the Issues history sort + order controls —
// one sort select keeping Latest selected, one adjacent toggle whose visible
// label, accessible name, and pressed state all track the active direction.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
// node --import tsx compiles JSX in classic mode: components reference the
// React global at render time. (Under automatic JSX runtimes this is inert.)
(globalThis as { React?: unknown }).React ??= React;
import { renderToStaticMarkup } from "react-dom/server";
import type { IssuesSortDirection } from "../../lib/issuesList.js";
import IssuesSortControls from "./IssuesSortControls.js";

function render(direction: IssuesSortDirection): string {
  return renderToStaticMarkup(
    React.createElement(IssuesSortControls, {
      sort: "latest",
      direction,
      onSortChange: () => {},
      onToggleDirection: () => {},
    })
  );
}

test("newest-first renders Latest selected with the newest-first order state", () => {
  const html = render("desc");
  assert.ok(html.includes('aria-label="Sort issues"'), "sort select is labeled");
  assert.ok(html.includes('value="latest"'), "Latest option exists");
  assert.ok(html.includes("selected"), "Latest stays selected");
  assert.ok(html.includes("Newest first"), "visible order reads newest-first");
  assert.ok(html.includes("↓"), "descending arrow shows");
  assert.ok(!html.includes("Oldest first"), "no oldest-first copy leaks in");
  assert.ok(html.includes('aria-label="Sort order: newest first"'), "accessible name states the active direction");
  assert.ok(html.includes('aria-pressed="false"'), "pressed state matches");
  assert.ok(html.includes('title="Show oldest first"'), "tooltip names the toggle action");
});

test("oldest-first renders the mirrored order state with Latest still selected", () => {
  const html = render("asc");
  assert.ok(html.includes("selected"), "Latest stays selected");
  assert.ok(html.includes("Oldest first"), "visible order reads oldest-first");
  assert.ok(html.includes("↑"), "ascending arrow shows");
  assert.ok(!html.includes("Newest first"), "no newest-first copy leaks in");
  assert.ok(html.includes('aria-label="Sort order: oldest first"'), "accessible name states the active direction");
  assert.ok(html.includes('aria-pressed="true"'), "pressed state matches");
  assert.ok(html.includes('title="Show newest first"'), "tooltip names the toggle action");
});

test("exactly one sort selector and one adjacent order toggle exist", () => {
  for (const html of [render("desc"), render("asc")]) {
    assert.equal(html.match(/<select/g)?.length ?? 0, 1, "a single sort selector");
    assert.equal(html.match(/<button/g)?.length ?? 0, 1, "a single order control, not a second selector");
    const selectAt = html.indexOf("<select");
    const buttonAt = html.indexOf("<button");
    assert.ok(selectAt !== -1 && buttonAt !== -1 && selectAt < buttonAt, "order control sits adjacent to the sort control");
  }
});
