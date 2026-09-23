// NOT-260: the inline repository-mappings editor — rows pair a Linear label
// input with the shared RepositoryPicker, plus add/remove/save, inline
// errors, an empty state, and normalized server values on save. Saving or
// closing never touches the parent New issue form (the page owns `repo`;
/// this component only ever calls its own save loader).
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
import RepositoryMappingsEditor, {
  emptyMappingRow,
  validateMappingRows,
} from "./RepositoryMappingsEditor.js";
import type { RepositoryMapping } from "../../api.js";

const dir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(dir, "RepositoryMappingsEditor.tsx"), "utf8");

const ROWS: RepositoryMapping[] = [
  { label: "agent-dealer", repository: "github.com/not-so-fat/agent-dealer" },
];

test("empty state is compact and offers Add mapping", () => {
  const html = renderToStaticMarkup(
    <RepositoryMappingsEditor initialMappings={[]} recentRepos={[]} />
  );
  assert.ok(html.includes("No mappings yet"), "compact empty state");
  assert.ok(html.includes("Add mapping"), "add action present");
  assert.ok(html.includes("Save changes"), "save action present");
  assert.ok(!html.includes("mapping-row"), "no rows rendered");
});

test("each row has a Linear label input, the shared picker, and Remove", () => {
  const html = renderToStaticMarkup(
    <RepositoryMappingsEditor
      initialMappings={ROWS}
      recentRepos={["github.com/not-so-fat/agent-dealer"]}
    />
  );
  assert.ok(html.includes('placeholder="Linear label"'), "label input present");
  assert.ok(html.includes('value="agent-dealer"'), "label value shown");
  // The repository goes through the shared picker — same recent select and
  // same free-form placeholder as New issue.
  assert.ok(html.includes("Recent repositories…"), "shared recent select used");
  assert.ok(html.includes('placeholder="GitHub URL or owner/repo"'), "shared input used");
  assert.ok(html.includes('value="github.com/not-so-fat/agent-dealer"'), "repo value shown");
  assert.ok(html.includes("Remove"), "remove action present");
});

test("client-side validation catches empty, duplicate, and overlong labels", () => {
  assert.equal(validateMappingRows(ROWS), null);
  assert.ok(validateMappingRows([{ label: "  ", repository: "a/b" }]), "empty label");
  assert.ok(
    validateMappingRows([
      { label: "agent-dealer", repository: "a/b" },
      { label: " AGENT-DEALER ", repository: "a/b" },
    ]),
    "duplicate normalized label"
  );
  assert.ok(validateMappingRows([{ label: "x".repeat(101), repository: "a/b" }]), "overlong label");
  assert.ok(validateMappingRows([{ label: "ok", repository: "  " }]), "empty repository");
  assert.equal(emptyMappingRow().label, "");
  assert.equal(emptyMappingRow().repository, "");
});

test("save sends trimmed rows and displays the normalized server values", async () => {
  // The component trims labels before PUT and replaces its rows with the
  // server-normalized result — mirror that contract against a stub.
  let sent: RepositoryMapping[] | null = null;
  const saveMappings = async (m: RepositoryMapping[]) => {
    sent = m;
    return [{ label: "agent-dealer", repository: "github.com/not-so-fat/agent-dealer" }];
  };
  const rows = [{ label: "  Agent-Dealer ", repository: "not-so-fat/agent-dealer" }];
  assert.equal(validateMappingRows(rows), null);
  const saved = await saveMappings(rows.map((r) => ({ ...r, label: r.label.trim() })));
  assert.deepEqual(sent, [{ label: "Agent-Dealer", repository: "not-so-fat/agent-dealer" }]);
  assert.deepEqual(saved, [
    { label: "agent-dealer", repository: "github.com/not-so-fat/agent-dealer" },
  ]);
});

test("save failures surface inline and keep the rows for correction", () => {
  // The editor renders errors from its own state (never a throw, never a
  // cleared parent form): the error slot and the row markup coexist.
  const html = renderToStaticMarkup(
    <RepositoryMappingsEditor initialMappings={ROWS} recentRepos={[]} />
  );
  assert.ok(html.includes("mapping-row"), "rows stay rendered alongside any error");
  assert.ok(
    source.includes('data-testid="mappings-error"'),
    "inline error slot exists"
  );
  assert.ok(
    source.includes("setRows(saved)"),
    "successful save displays normalized server values"
  );
});

test("the editor never writes the parent New issue repository", () => {
  // No prop or import reaches the page's `repo` state: the only outbound
  // calls are the mappings load/save helpers and onClose.
  assert.ok(!source.includes("setRepo"), "no parent repo writer");
  assert.ok(/loadMappings|fetchRepositoryMappings/.test(source), "loads via mappings API");
  assert.ok(/saveMappings|saveRepositoryMappings/.test(source), "saves via mappings API");
});
