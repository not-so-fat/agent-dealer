// NOT-271: provider identity — all four runtimes render image-based logo
// tiles through the shared LogoTile path. Codex and Muse must not fall back
// to the old Cx/Mu text glyphs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import React from "react";
(globalThis as { React?: unknown }).React ??= React;

register("../../test-helpers/asset-stub-hooks.mjs", import.meta.url);

const { renderToStaticMarkup } = await import("react-dom/server");
const {
  AgentRuntimeIcon,
  ClaudeIcon,
  CodexIcon,
  CursorIcon,
  GenericAgentIcon,
  MuseIcon,
} = await import("./AgentIcon.js");

function render(el: React.ReactElement) {
  return renderToStaticMarkup(el);
}

test("all four runtimes render image-based logo tiles with 32x32 outer geometry", () => {
  for (const [runtime, Icon] of [
    ["claude_code", ClaudeIcon],
    ["cursor_local", CursorIcon],
    ["codex_local", CodexIcon],
    ["muse_code", MuseIcon],
  ] as const) {
    const html = render(React.createElement(Icon, {}));
    assert.match(html, /<img/, `${runtime}: renders an image tile`);
    assert.match(html, /alt=""/, `${runtime}: tile image is decorative`);
    assert.match(html, /h-8 w-8/, `${runtime}: keeps the 32x32 agent-card geometry`);
    const viaMapping = render(React.createElement(AgentRuntimeIcon, { runtime, className: "h-8 w-8" }));
    assert.equal(viaMapping, html, `${runtime}: shared mapping renders the same tile`);
  }
});

test("Codex and Muse tiles contain no Cx/Mu glyphs", () => {
  for (const [name, Icon] of [["codex", CodexIcon], ["muse", MuseIcon]] as const) {
    const html = render(React.createElement(Icon, {}));
    assert.ok(!html.includes("<text"), `${name}: no SVG text glyph element`);
    assert.ok(!html.includes(">Cx<"), `${name}: no Cx placeholder`);
    assert.ok(!html.includes(">Mu<"), `${name}: no Mu placeholder`);
  }
});

test("icon size is caller-controlled: top-bar tiles render at 16x16", () => {
  const html = render(React.createElement(AgentRuntimeIcon, { runtime: "codex_local", className: "h-4 w-4 shrink-0" }));
  assert.match(html, /<img/, "still an image tile at top-bar size");
  assert.match(html, /h-4 w-4/, "top-bar tile is exactly 16x16");
  assert.ok(!html.includes("h-8 w-8"), "top-bar tile does not keep card geometry");
});

test("unknown runtime keeps a safe generic fallback icon", () => {
  const html = render(
    React.createElement(AgentRuntimeIcon, { runtime: "something_new" as never })
  );
  assert.match(html, /<svg/, "unknown runtime renders the generic SVG icon");
  assert.ok(!html.includes("<img"), "unknown runtime renders no provider image");
  const generic = render(
    React.createElement(GenericAgentIcon, { className: "h-8 w-8 shrink-0" })
  );
  assert.equal(html, generic, "fallback matches the generic icon");
});
