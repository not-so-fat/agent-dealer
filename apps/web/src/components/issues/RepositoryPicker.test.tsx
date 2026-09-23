// NOT-260: the shared RepositoryPicker keeps the New issue interaction —
// a Recent repositories select when recents exist plus the free-form
// GitHub URL or owner/repo input; both replace the current value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
// node --import tsx compiles JSX in classic mode: components reference the
// React global at render time. (Under automatic JSX runtimes this is inert.)
(globalThis as { React?: unknown }).React ??= React;
import { renderToStaticMarkup } from "react-dom/server";
import RepositoryPicker from "./RepositoryPicker.js";

const dir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(dir, "RepositoryPicker.tsx"), "utf8");

test("shows the recent select only when recent repositories exist", () => {
  const withRecents = renderToStaticMarkup(
    <RepositoryPicker value="" onChange={() => undefined} recentRepos={["github.com/a/one"]} />
  );
  assert.ok(withRecents.includes("Recent repositories…"), "recent select shown");
  assert.ok(withRecents.includes("github.com/a/one"), "recent repo listed");

  const bare = renderToStaticMarkup(
    <RepositoryPicker value="" onChange={() => undefined} recentRepos={[]} />
  );
  assert.ok(!bare.includes("<select"), "no select without recents");
});

test("always shows the free-form input with the shared placeholder", () => {
  for (const recents of [[], ["github.com/a/one"]]) {
    const html = renderToStaticMarkup(
      <RepositoryPicker value="" onChange={() => undefined} recentRepos={recents} />
    );
    assert.ok(html.includes('placeholder="GitHub URL or owner/repo"'), "free-form input kept");
  }
});

test("the rendered value follows the current repository, including mapped defaults", () => {
  const html = renderToStaticMarkup(
    <RepositoryPicker
      value="github.com/not-so-fat/agent-dealer"
      onChange={() => undefined}
      recentRepos={["github.com/not-so-fat/agent-dealer", "github.com/not-so-fat/other"]}
    />
  );
  assert.ok(html.includes('value="github.com/not-so-fat/agent-dealer"'), "input shows the value");
});

test("choosing a recent repository replaces the current value", () => {
  assert.ok(
    /onChange=\{\(e\) => \{\s*if \(e\.target\.value\) onChange\(e\.target\.value\);\s*\}\}/s.test(source),
    "recent select calls onChange with the chosen repository"
  );
});

test("typing or pasting replaces the current value", () => {
  assert.ok(
    source.includes("onChange={(e) => onChange(e.target.value)}"),
    "free-form input calls onChange with the typed value"
  );
});
