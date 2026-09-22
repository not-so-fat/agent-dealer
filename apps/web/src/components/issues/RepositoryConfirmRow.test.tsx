// NOT-242: the Repository confirmation row names the exact canonical identity,
// its source label, and the blocking state; confirmation is explicit.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
// node --import tsx compiles JSX in classic mode: components reference the
// React global at render time.
(globalThis as { React?: unknown }).React ??= React;
import { renderToStaticMarkup } from "react-dom/server";
import RepositoryConfirmRow from "./RepositoryConfirmRow.js";

function render(props: Partial<Parameters<typeof RepositoryConfirmRow>[0]> = {}): string {
  return renderToStaticMarkup(
    React.createElement(RepositoryConfirmRow, {
      canonical: "github.com/not-so-fat/agent-dealer",
      confirmedRepo: null,
      hint: {
        status: "resolved",
        repository: "github.com/not-so-fat/agent-dealer",
        sourceLabel: "repo:github.com/not-so-fat/agent-dealer",
      },
      linearIdentifier: "NOT-242",
      onConfirm: () => undefined,
      onChangeRepo: () => undefined,
      ...props,
    })
  );
}

test("resolved state shows the canonical identity, source label, and confirm action", () => {
  const html = render();
  assert.ok(html.includes("github.com/not-so-fat/agent-dealer"), "canonical identity shown");
  assert.ok(html.includes("repo:github.com/not-so-fat/agent-dealer"), "source label named");
  assert.ok(html.includes("Confirm this repository"), "confirm action offered");
  assert.ok(html.includes("Change"), "change action offered");
  assert.ok(html.includes('aria-label="Repository confirmation"'), "row is a separated section");
  assert.ok(!html.includes("Repository confirmed"), "not yet confirmed");
});

test("confirmed state names the confirmed identity instead of the button", () => {
  const html = render({ confirmedRepo: "github.com/not-so-fat/agent-dealer" });
  assert.ok(html.includes("Repository confirmed"), "confirmed badge shown");
  assert.ok(!html.includes("Confirm this repository"), "confirm action gone once confirmed");
});

test("stale confirmation reads as unconfirmed", () => {
  const html = render({ confirmedRepo: "github.com/not-so-fat/other" });
  assert.ok(html.includes("Confirm this repository"), "must confirm the current identity again");
});

test("unresolved state explains the label convention with no default", () => {
  const html = render({ canonical: null, hint: { status: "unresolved" } });
  assert.ok(html.includes("NOT-242"), "names the ticket");
  assert.ok(html.includes("repo:"), "explains how to add the label");
  assert.ok(html.includes("or choose the repository manually"), "manual fallback named");
  assert.ok(html.includes("disabled"), "confirm has nothing valid to confirm");
});

test("conflict lists every label and never a single pick", () => {
  const html = render({
    canonical: null,
    hint: { status: "conflict", labels: ["repo:github.com/a/one", "repo:github.com/b/two"] },
  });
  assert.ok(html.includes("Conflicting"), "blocking copy shown");
  assert.ok(html.includes("repo:github.com/a/one"), "first label shown");
  assert.ok(html.includes("repo:github.com/b/two"), "second label shown");
});

test("invalid state shows the bad label and the reason", () => {
  const html = render({
    canonical: null,
    hint: {
      status: "invalid",
      labels: ["repo:https://gitlab.com/acme/app"],
      error: "Only github.com repositories are supported (got host gitlab.com)",
    },
  });
  assert.ok(html.includes("repo:https://gitlab.com/acme/app"), "invalid label shown");
  assert.ok(html.includes("gitlab.com"), "parser reason shown");
});

test("manual creation has no Linear provenance but keeps the row", () => {
  const html = render({ hint: null, linearIdentifier: null });
  assert.ok(html.includes("Manual entry"), "manual provenance shown");
  assert.ok(html.includes("Confirm this repository"), "confirmation still required");
});

test("manually edited repo in Linear mode is an override, not label provenance", () => {
  const html = render({ canonical: "github.com/not-so-fat/other-repo" });
  assert.ok(html.includes("Manual override"), "override copy shown");
  assert.ok(!html.includes("From Linear label"), "must not claim the edited value came from the label");
  assert.ok(
    html.includes("repo:github.com/not-so-fat/agent-dealer"),
    "still names the source label for traceability"
  );
  assert.ok(html.includes("github.com/not-so-fat/other-repo"), "shows the edited identity");
  assert.ok(html.includes("Confirm this repository"), "overridden identity needs fresh confirmation");
});

test("conflict hint with a manual value names it as manual, not label-derived", () => {
  const html = render({
    canonical: "github.com/not-so-fat/agent-dealer",
    hint: { status: "conflict", labels: ["repo:github.com/a/one", "repo:github.com/b/two"] },
  });
  assert.ok(html.includes("Conflicting"), "conflict block still shown");
  assert.ok(html.includes("chosen manually, not from a Linear label"), "manual value disclaimed");
});

test("invalid hint with a manual value names it as manual, not label-derived", () => {
  const html = render({
    canonical: "github.com/not-so-fat/agent-dealer",
    hint: {
      status: "invalid",
      labels: ["repo:https://gitlab.com/acme/app"],
      error: "Only github.com repositories are supported (got host gitlab.com)",
    },
  });
  assert.ok(html.includes("Invalid repository label"), "invalid block still shown");
  assert.ok(html.includes("chosen manually, not from a Linear label"), "manual value disclaimed");
});

test("unresolved hint with a manual value names it as manual", () => {
  const html = render({
    canonical: "github.com/not-so-fat/agent-dealer",
    hint: { status: "unresolved" },
  });
  assert.ok(html.includes("no"), "unresolved copy still shown");
  assert.ok(html.includes("chosen manually, not from a Linear label"), "manual value disclaimed");
});
