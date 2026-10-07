// NOT-364: the Source attachments summary distinguishes durable files from
// metadata-only links and stays absent when there is nothing to show.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
// node --import tsx compiles JSX in classic mode: components reference the
// React global at render time. (Under automatic JSX runtimes this is inert.)
(globalThis as { React?: unknown }).React ??= React;
import { renderToStaticMarkup } from "react-dom/server";
import type { SourceAttachmentRecord } from "@agent-dealer/shared";
import SourceAttachmentsSection from "./SourceAttachmentsSection.js";

const FILE: SourceAttachmentRecord = {
  linearAttachmentId: "att-file-1",
  kind: "file",
  title: "repro.tar.gz",
  safeFileName: "repro.tar.gz",
  blobPath: "/data/source-attachments/issue-1/repro.tar.gz",
  contentType: "application/gzip",
  sizeBytes: 12345,
  sha256: `${"ab".repeat(32)}`,
  url: "https://uploads.linear.app/a/repro.tar.gz",
};

const LINK: SourceAttachmentRecord = {
  linearAttachmentId: "att-link-1",
  kind: "link",
  title: "Design doc",
  url: "https://docs.example.com/x",
  subtitle: "Spec",
};

test("section lists files with safe name, size and checksum, links as labeled URLs", () => {
  const html = renderToStaticMarkup(<SourceAttachmentsSection attachments={[FILE, LINK]} />);
  assert.match(html, /Source attachments/);
  assert.match(html, /repro\.tar\.gz/);
  assert.match(html, /12,345 bytes/);
  assert.match(html, new RegExp(`sha256:${"ab".repeat(8)}`));
  assert.match(html, /application\/gzip/);
  assert.match(html, /Design doc/);
  assert.match(html, /https:\/\/docs\.example\.com\/x/);
  // File/link kinds are explicitly labeled; server blob paths stay server-side.
  assert.match(html, /file/);
  assert.match(html, /link/);
  assert.doesNotMatch(html, /\/data\/source-attachments\//);
});

test("section is absent for empty or missing attachments", () => {
  assert.equal(renderToStaticMarkup(<SourceAttachmentsSection attachments={[]} />), "");
  assert.equal(renderToStaticMarkup(<SourceAttachmentsSection attachments={undefined} />), "");
});
