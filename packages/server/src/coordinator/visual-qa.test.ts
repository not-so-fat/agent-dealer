// packages/server/src/coordinator/visual-qa.test.ts
//
// NOT-381: runtime-aware visual-QA policy, structured receipt parsing,
// SHA-bound validation, and reviewer-section rendering. Pure tests only —
// artifact persistence and worktree collection live in
// visual-qa-collection.test.ts (they need a database + git worktree).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  VISUAL_QA_DIR_NAME,
  capableDeveloperVisualQaPromptSection,
  developerVisualQaPolicy,
  parseVisualQaReceipt,
  validateVisualQaReceipt,
  visualQaReviewerSection,
  type ParsedVisualQaReceipt,
  type VisualQaRecord,
} from "./visual-qa.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

function verifiedConclusion(head = HEAD_A): string {
  return [
    `Implemented the widget and its tests.`,
    ``,
    `Visual QA: verified`,
    `head: ${head}`,
    `app: real (no mocks)`,
    `scenario: /widgets/new — fill the form and submit`,
    `viewports: 1440x900, 390x800`,
    `commands: npm run dev:api & npm run dev:web -- --port 4321; capture via chromium headless screenshot`,
    `screenshots: ${VISUAL_QA_DIR_NAME}/desktop-1440x900.png, ${VISUAL_QA_DIR_NAME}/mobile-390x800.png`,
    ``,
  ].join("\n");
}

function writeWorktree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-visualqa-"));
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  return dir;
}

function parsedVerified(head = HEAD_A): ParsedVisualQaReceipt {
  const parsed = parseVisualQaReceipt(verifiedConclusion(head));
  assert.equal(parsed.found, true);
  assert.ok(parsed.found && parsed.receipt);
  return parsed.receipt;
}

// Policy: only Muse keeps the preflight; every other runtime attempts in-session.

test("NOT-381: policy keeps Muse on the preflight and gives capable runtimes the in-session attempt", () => {
  assert.equal(developerVisualQaPolicy("muse_code"), "muse");
  assert.equal(developerVisualQaPolicy("claude_code"), "capable");
  assert.equal(developerVisualQaPolicy("codex_local"), "capable");
  assert.equal(developerVisualQaPolicy("cursor_local"), "capable");
});

test("NOT-381: unknown runtimes default to capable — the probe degrades to unavailable, never a missed verification", () => {
  assert.equal(developerVisualQaPolicy(null), "capable");
  assert.equal(developerVisualQaPolicy(undefined), "capable");
  assert.equal(developerVisualQaPolicy("some_future_runtime"), "capable");
});

test("NOT-381: capable section requires one bounded probe, the real app, defaults, and a structured receipt", () => {
  const text = capableDeveloperVisualQaPromptSection().join("\n");
  assert.match(text, /## Visual QA/);
  assert.match(text, /ONE bounded capability probe/);
  assert.match(text, /loopback/);
  assert.match(text, /do not install browsers or packages/);
  assert.match(text, /do not retry the failed capability/);
  assert.match(text, /do not weaken any sandbox flag/);
  assert.match(text, /REAL backend and frontend/);
  assert.match(text, /Use mocks only when an acceptance criterion explicitly permits them/);
  assert.match(text, /1440x900/);
  assert.match(text, /390x800/);
  assert.match(text, /\.agent-dealer-visual-qa\//);
  assert.match(text, /never commit it/);
  assert.match(text, /Visual QA: verified/);
  assert.match(text, /head:/);
  assert.match(text, /screenshots:/);
  assert.match(text, /Visual QA: unavailable/);
  assert.match(text, /capability:/);
  assert.match(text, /Visual QA: not_required/);
  assert.doesNotMatch(text, /--yolo/);
});

// Parsing.

test("NOT-381: parses a full verified block", () => {
  const receipt = parsedVerified();
  assert.equal(receipt.status, "verified");
  assert.equal(receipt.headSha, HEAD_A);
  assert.equal(receipt.realApp, "real (no mocks)");
  assert.match(receipt.scenario!, /\/widgets\/new/);
  assert.deepEqual(receipt.viewports, ["1440x900", "390x800"]);
  assert.match(receipt.commands!, /chromium/);
  assert.deepEqual(receipt.screenshots, [
    `${VISUAL_QA_DIR_NAME}/desktop-1440x900.png`,
    `${VISUAL_QA_DIR_NAME}/mobile-390x800.png`,
  ]);
  assert.equal(receipt.capability, null);
});

test("NOT-381: no Visual QA line means no receipt, not an error", () => {
  assert.deepEqual(parseVisualQaReceipt("Implemented the widget.\nNo screenshots.\n"), { found: false });
});

test("NOT-381: unknown status fails loudly", () => {
  const parsed = parseVisualQaReceipt("Done.\n\nVisual QA: done\n");
  assert.equal(parsed.found, true);
  assert.ok(parsed.found && !parsed.receipt);
  assert.match(parsed.error, /unknown Visual QA status "done"/);
});

test("NOT-381: last Visual QA block wins when the worker corrects itself", () => {
  const parsed = parseVisualQaReceipt(
    `Visual QA: unavailable\ncapability: browser launch: no chromium\n\nActually fixed it:\n\n${verifiedConclusion()}`
  );
  assert.equal(parsed.found, true);
  assert.ok(parsed.found && parsed.receipt);
  assert.equal(parsed.receipt.status, "verified");
});

test("NOT-381: parses unavailable with a concrete capability, inline or field form", () => {
  const field = parseVisualQaReceipt(`Visual QA: unavailable\nhead: ${HEAD_A}\ncapability: loopback listen: EPERM\n`);
  assert.equal(field.found, true);
  assert.ok(field.found && field.receipt);
  assert.equal(field.receipt.status, "unavailable");
  assert.equal(field.receipt.capability, "loopback listen: EPERM");
  assert.equal(field.receipt.headSha, HEAD_A);

  const inline = parseVisualQaReceipt(`Visual QA: unavailable (browser launch: chromium binary not found)\n`);
  assert.ok(inline.found && inline.receipt);
  assert.equal(inline.receipt!.status, "unavailable");
  assert.equal(inline.receipt!.capability, "browser launch: chromium binary not found");
});

test("NOT-381: legacy Muse `not run` line normalizes to unavailable, never to a pass", () => {
  const parsed = parseVisualQaReceipt(
    `Visual QA: not run (no headless shell installed, and Google Chrome.app headless aborts in-session)\n`
  );
  assert.ok(parsed.found && parsed.receipt);
  assert.equal(parsed.receipt!.status, "unavailable");
  assert.match(parsed.receipt!.capability!, /no headless shell installed/);
});

test("NOT-381: bare `not run` without a reason parses with no capability (validation rejects it)", () => {
  const parsed = parseVisualQaReceipt(`Visual QA: not run\n`);
  assert.ok(parsed.found && parsed.receipt);
  assert.equal(parsed.receipt!.status, "unavailable");
  assert.equal(parsed.receipt!.capability, null);
  const validation = validateVisualQaReceipt(parsed.receipt!, { expectedHeadSha: HEAD_A, worktreePath: "/none" });
  assert.equal(validation.ok, false);
  assert.match((validation as { reason: string }).reason, /names no failed capability/);
});

test("NOT-381: not_required accepts underscore, hyphen, and space spellings", () => {
  for (const token of ["not_required", "not-required", "not required"]) {
    const parsed = parseVisualQaReceipt(`No UI changed.\n\nVisual QA: ${token}\n`);
    assert.ok(parsed.found && parsed.receipt, token);
    assert.equal(parsed.receipt!.status, "not_required");
  }
});

test("NOT-381: legacy Muse usable-shell verified line parses with no fields (validation rejects it)", () => {
  const parsed = parseVisualQaReceipt(`Visual QA: verified (shot.png, exit 0)\n`);
  assert.ok(parsed.found && parsed.receipt);
  assert.equal(parsed.receipt!.status, "verified");
  assert.equal(parsed.receipt!.headSha, null);
  const validation = validateVisualQaReceipt(parsed.receipt!, { expectedHeadSha: HEAD_A, worktreePath: "/none" });
  assert.equal(validation.ok, false);
  assert.match((validation as { reason: string }).reason, /names no HEAD SHA/);
});

test("NOT-381: fields stop at a markdown heading or fence; singular aliases work", () => {
  const parsed = parseVisualQaReceipt(
    [
      `Visual QA: verified`,
      `sha: ${HEAD_A}`,
      `app: real`,
      `path: /login`,
      `viewport: 1440x900`,
      `command: npm run dev; screenshot`,
      `screenshot: ${VISUAL_QA_DIR_NAME}/a.png`,
      ``,
      `## Follow-ups`,
      `viewport: 1x1`,
      "```",
      `head: ${HEAD_B}`,
    ].join("\n")
  );
  assert.ok(parsed.found && parsed.receipt);
  const r = parsed.receipt!;
  assert.equal(r.headSha, HEAD_A);
  assert.equal(r.scenario, "/login");
  assert.deepEqual(r.viewports, ["1440x900"]);
  assert.deepEqual(r.screenshots, [`${VISUAL_QA_DIR_NAME}/a.png`]);
});

// Validation: verified.

test("NOT-381: verified receipt is accepted when SHA binds and screenshots are regular files in the artifact dir", () => {
  const dir = writeWorktree({
    [`${VISUAL_QA_DIR_NAME}/desktop-1440x900.png`]: "png-bytes",
    [`${VISUAL_QA_DIR_NAME}/mobile-390x800.png`]: "png-bytes",
  });
  try {
    assert.deepEqual(validateVisualQaReceipt(parsedVerified(), { expectedHeadSha: HEAD_A, worktreePath: dir }), {
      ok: true,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("NOT-381: SHA mismatch fails loudly", () => {
  const dir = writeWorktree({ [`${VISUAL_QA_DIR_NAME}/desktop-1440x900.png`]: "x" });
  try {
    const v = validateVisualQaReceipt(parsedVerified(HEAD_B), { expectedHeadSha: HEAD_A, worktreePath: dir });
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /bound to bbbbbbbb but the developer handoff is aaaaaaaa/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("NOT-381: missing or invalid HEAD fails loudly", () => {
  const dir = writeWorktree({});
  try {
    const missing = { ...parsedVerified(), headRaw: null, headSha: null };
    assert.match(
      (validateVisualQaReceipt(missing, { expectedHeadSha: HEAD_A, worktreePath: dir }) as { reason: string }).reason,
      /names no HEAD SHA/
    );
    const invalid = { ...parsedVerified(), headRaw: "zzz", headSha: null };
    assert.match(
      (validateVisualQaReceipt(invalid, { expectedHeadSha: HEAD_A, worktreePath: dir }) as { reason: string }).reason,
      /invalid HEAD SHA/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("NOT-381: each missing verified field fails loudly", () => {
  const dir = writeWorktree({});
  try {
    const base = parsedVerified();
    const cases: Array<[keyof ParsedVisualQaReceipt, RegExp]> = [
      ["realApp", /real-app\/mocks/],
      ["scenario", /scenario\/path/],
      ["commands", /commands summary/],
    ];
    for (const [key, re] of cases) {
      const v = validateVisualQaReceipt({ ...base, [key]: null }, { expectedHeadSha: HEAD_A, worktreePath: dir });
      assert.equal(v.ok, false, String(key));
      assert.match((v as { reason: string }).reason, re);
    }
    const noViewports = validateVisualQaReceipt(
      { ...base, viewports: [], viewportsRaw: null },
      { expectedHeadSha: HEAD_A, worktreePath: dir }
    );
    assert.match((noViewports as { reason: string }).reason, /no viewport sizes/);
    const noScreenshots = validateVisualQaReceipt(
      { ...base, screenshots: [] },
      { expectedHeadSha: HEAD_A, worktreePath: dir }
    );
    assert.match((noScreenshots as { reason: string }).reason, /no screenshot files/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("NOT-381: missing screenshot file fails loudly", () => {
  const dir = writeWorktree({ [`${VISUAL_QA_DIR_NAME}/desktop-1440x900.png`]: "x" });
  try {
    const v = validateVisualQaReceipt(parsedVerified(), { expectedHeadSha: HEAD_A, worktreePath: dir });
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /screenshot is missing/);
    assert.match((v as { reason: string }).reason, /mobile-390x800\.png/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("NOT-381: screenshot symlink fails loudly", () => {
  const dir = writeWorktree({
    [`${VISUAL_QA_DIR_NAME}/desktop-1440x900.png`]: "x",
    "real.png": "x",
  });
  fs.symlinkSync(path.join(dir, "real.png"), path.join(dir, VISUAL_QA_DIR_NAME, "mobile-390x800.png"));
  try {
    const v = validateVisualQaReceipt(parsedVerified(), { expectedHeadSha: HEAD_A, worktreePath: dir });
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /is a symlink, refusing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("NOT-381: symlinked artifact directory fails loudly (realpath escapes the worktree)", () => {
  const dir = writeWorktree({ "keep.txt": "x" });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-visualqa-out-"));
  try {
    fs.writeFileSync(path.join(outside, "desktop-1440x900.png"), "x");
    fs.writeFileSync(path.join(outside, "mobile-390x800.png"), "x");
    fs.symlinkSync(outside, path.join(dir, VISUAL_QA_DIR_NAME));
    const v = validateVisualQaReceipt(parsedVerified(), { expectedHeadSha: HEAD_A, worktreePath: dir });
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /visual-artifact directory is a symlink, refusing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("NOT-381: symlinked subdirectory fails loudly (intermediate symlink escapes the worktree)", () => {
  const dir = writeWorktree({ [`${VISUAL_QA_DIR_NAME}/desktop-1440x900.png`]: "x" });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-visualqa-out-"));
  try {
    fs.writeFileSync(path.join(outside, "mobile-390x800.png"), "x");
    fs.symlinkSync(outside, path.join(dir, VISUAL_QA_DIR_NAME, "sub"));
    const base = parsedVerified();
    const v = validateVisualQaReceipt(
      {
        ...base,
        screenshots: [`${VISUAL_QA_DIR_NAME}/desktop-1440x900.png`, `${VISUAL_QA_DIR_NAME}/sub/mobile-390x800.png`],
      },
      { expectedHeadSha: HEAD_A, worktreePath: dir }
    );
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /traverses a symlink, refusing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("NOT-381: screenshot path traversal and absolute paths fail loudly", () => {
  const dir = writeWorktree({
    "evil.png": "x",
    [`${VISUAL_QA_DIR_NAME}/desktop-1440x900.png`]: "x",
  });
  try {
    const base = parsedVerified();
    for (const evil of ["../evil.png", `${VISUAL_QA_DIR_NAME}/../../evil.png`, "/tmp/evil.png"]) {
      const v = validateVisualQaReceipt(
        { ...base, screenshots: [`${VISUAL_QA_DIR_NAME}/desktop-1440x900.png`, evil] },
        { expectedHeadSha: HEAD_A, worktreePath: dir }
      );
      assert.equal(v.ok, false, evil);
      assert.match((v as { reason: string }).reason, /absolute screenshot path|escapes the visual-artifact directory/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("NOT-381: non-regular, empty, and wrong-extension screenshots fail loudly", () => {
  const dir = writeWorktree({ [`${VISUAL_QA_DIR_NAME}/desktop-1440x900.png`]: "x" });
  fs.mkdirSync(path.join(dir, VISUAL_QA_DIR_NAME, "mobile-390x800.png"));
  try {
    const base = parsedVerified();
    const vDir = validateVisualQaReceipt(base, { expectedHeadSha: HEAD_A, worktreePath: dir });
    assert.equal(vDir.ok, false);
    assert.match((vDir as { reason: string }).reason, /not a regular file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const empty = writeWorktree({
    [`${VISUAL_QA_DIR_NAME}/desktop-1440x900.png`]: "x",
    [`${VISUAL_QA_DIR_NAME}/mobile-390x800.png`]: "",
  });
  try {
    const v = validateVisualQaReceipt(parsedVerified(), { expectedHeadSha: HEAD_A, worktreePath: empty });
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /is empty/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }

  const wrongExt = writeWorktree({
    [`${VISUAL_QA_DIR_NAME}/desktop-1440x900.png`]: "x",
    [`${VISUAL_QA_DIR_NAME}/notes.txt`]: "x",
  });
  try {
    const v = validateVisualQaReceipt(
      { ...parsedVerified(), screenshots: [`${VISUAL_QA_DIR_NAME}/desktop-1440x900.png`, `${VISUAL_QA_DIR_NAME}/notes.txt`] },
      { expectedHeadSha: HEAD_A, worktreePath: wrongExt }
    );
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /unsupported extension/);
  } finally {
    fs.rmSync(wrongExt, { recursive: true, force: true });
  }
});

// Validation: unavailable / not_required.

test("NOT-381: unavailable requires one concrete failed capability", () => {
  const ok = validateVisualQaReceipt(
    { ...parsedVerified(), status: "unavailable", capability: "browser launch: no chromium" },
    { expectedHeadSha: HEAD_A, worktreePath: "/none" }
  );
  assert.deepEqual(ok, { ok: true });
  // No screenshots needed, no SHA binding enforced — the capability is the record.
  const minimal = validateVisualQaReceipt(
    {
      status: "unavailable",
      headSha: null,
      headRaw: null,
      realApp: null,
      scenario: null,
      viewports: [],
      viewportsRaw: null,
      commands: null,
      screenshots: [],
      capability: "loopback listen: EPERM",
      note: null,
    },
    { expectedHeadSha: HEAD_A, worktreePath: "/none" }
  );
  assert.deepEqual(minimal, { ok: true });
});

test("NOT-381: not_required validates with no screenshots and no other fields", () => {
  const v = validateVisualQaReceipt(
    {
      status: "not_required",
      headSha: null,
      headRaw: null,
      realApp: null,
      scenario: null,
      viewports: [],
      viewportsRaw: null,
      commands: null,
      screenshots: [],
      capability: null,
      note: null,
    },
    { expectedHeadSha: HEAD_A, worktreePath: "/none" }
  );
  assert.deepEqual(v, { ok: true });
});

// Reviewer section.

function receiptRecord(contentOver: Record<string, unknown> = {}): VisualQaRecord {
  return {
    kind: "receipt",
    createdAt: "2026-10-08T00:00:00.000Z",
    content: {
      status: "verified",
      headSha: HEAD_A,
      realApp: "real (no mocks)",
      scenario: "/widgets/new — fill the form and submit",
      viewports: ["1440x900", "390x800"],
      commands: "npm run dev; capture",
      screenshots: [
        { fileName: "0-desktop.png", blobPath: "/blobs/0-desktop.png", sizeBytes: 1234, sha256: "ab".repeat(32) },
      ],
      capability: null,
      note: null,
      recordedAt: "2026-10-08T00:00:00.000Z",
      ...contentOver,
    },
  } as VisualQaRecord;
}

test("NOT-381: no record renders nothing", () => {
  assert.deepEqual(visualQaReviewerSection(null, HEAD_A), []);
});

test("NOT-381: verified receipt bound to the pinned head renders the full evidence block", () => {
  const text = visualQaReviewerSection(receiptRecord(), HEAD_A).join("\n");
  assert.match(text, /## Visual QA \(developer receipt — SHA-bound to this head\)/);
  assert.match(text, new RegExp(HEAD_A));
  assert.match(text, /real \(no mocks\)/);
  assert.match(text, /\/widgets\/new/);
  assert.match(text, /1440x900, 390x800/);
  assert.match(text, /0-desktop\.png/);
  assert.match(text, /not as your own verification/);
});

test("NOT-381: verified receipt bound to another head is stale, never verification", () => {
  const text = visualQaReviewerSection(receiptRecord(), HEAD_B).join("\n");
  assert.match(text, /## Visual QA \(stale receipt — not this head\)/);
  assert.match(text, /do not treat this as verification of the pinned head/);
  assert.doesNotMatch(text, /SHA-bound to this head/);
});

test("NOT-381: unavailable receipt names the failed capability and is never a pass", () => {
  const record = receiptRecord({
    status: "unavailable",
    headSha: HEAD_A,
    realApp: null,
    scenario: null,
    viewports: [],
    commands: null,
    screenshots: [],
    capability: "browser launch: chromium binary not found",
    note: null,
  });
  const text = visualQaReviewerSection(record, HEAD_A).join("\n");
  assert.match(text, /## Visual QA \(UNAVAILABLE — not verified\)/);
  assert.match(text, /browser launch: chromium binary not found/);
  assert.match(text, /never a pass/);
  assert.doesNotMatch(text, /verified at/);
});

test("NOT-381: not_required renders the no-surface claim with the reviewer override", () => {
  const record = receiptRecord({
    status: "not_required",
    headSha: null,
    realApp: null,
    scenario: null,
    viewports: [],
    commands: null,
    screenshots: [],
    capability: null,
    note: null,
  });
  const text = visualQaReviewerSection(record, HEAD_A).join("\n");
  assert.match(text, /## Visual QA \(not required/);
  assert.match(text, /blocking finding/);
});

test("NOT-381: rejection bound to the pinned head fails loudly in the reviewer input", () => {
  const record: VisualQaRecord = {
    kind: "rejected",
    createdAt: "2026-10-08T00:00:00.000Z",
    content: {
      status: "verified",
      headSha: HEAD_B,
      expectedHeadSha: HEAD_A,
      reason: `verified Visual QA receipt is bound to ${HEAD_B.slice(0, 8)} but the developer handoff is ${HEAD_A.slice(0, 8)}`,
      recordedAt: "2026-10-08T00:00:00.000Z",
    },
  };
  const text = visualQaReviewerSection(record, HEAD_A).join("\n");
  assert.match(text, /## Visual QA \(INVALID receipt/);
  assert.match(text, /bound to bbbbbbbb but the developer handoff is aaaaaaaa/);
  assert.match(text, /never verification/);
});

test("NOT-381: rejection for another head is superseded, not shown as this head's verdict", () => {
  const record: VisualQaRecord = {
    kind: "rejected",
    createdAt: "2026-10-08T00:00:00.000Z",
    content: {
      status: "verified",
      headSha: HEAD_B,
      expectedHeadSha: HEAD_B,
      reason: "screenshot is missing",
      recordedAt: "2026-10-08T00:00:00.000Z",
    },
  };
  const text = visualQaReviewerSection(record, HEAD_A).join("\n");
  assert.match(text, /superseded rejection — not this head/);
  assert.doesNotMatch(text, /INVALID receipt/);
});
