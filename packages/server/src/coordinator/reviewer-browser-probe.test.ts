// packages/server/src/coordinator/reviewer-browser-probe.test.ts
//
// NOT-380 acceptance: focused unit tests cover result parsing and fail-closed
// behavior for missing fields or an unexecuted probe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MUSE_PROBE_BLOCKED_REASON,
  REVIEWER_ATTEMPTED_CONTROL_IDS,
  REVIEWER_BROWSER_PROBE_SCHEMA_VERSION,
  REVIEWER_BROWSER_VIEWPORTS,
  REVIEWER_NEGATIVE_CONTROL_IDS,
  buildReviewerBrowserProbePrompt,
  canonicalProbeJson,
  computeProbeStatus,
  overlayPlaywrightMcpConfig,
  parseReviewerBrowserProbeReport,
  probeManifestFilename,
  resolveProbeArgv,
  runReviewerBrowserProbe,
  sanitizeProbeManifest,
  unexecutedProbeManifest,
  withManifestHash,
  type ReviewerBrowserProbeCleanup,
  type ReviewerBrowserProbeControl,
  type ReviewerBrowserProbeLaunch,
  type ReviewerBrowserProbeReport,
} from "./reviewer-browser-probe.js";
import { assertReviewerReadOnly } from "./permissions.js";
import { roleCeiling } from "@agent-dealer/shared";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const SHOT = "c".repeat(64);

function deniedControl(id: string): ReviewerBrowserProbeControl {
  return {
    id,
    action: `attempted ${id}`,
    expected: "deny",
    observed: "denied by policy",
    denied: true,
    exitStatus: null,
    detail: "policy denial",
  };
}

function validReport(overrides: Partial<ReviewerBrowserProbeReport> = {}): ReviewerBrowserProbeReport {
  return {
    headSha: HEAD,
    runtimeVersion: "claude 2.1.0",
    loopback: { attempted: true, succeeded: true, detail: "listened on 127.0.0.1:0" },
    browser: {
      attempted: true,
      launched: true,
      binary: "/tmp/probe/chromium",
      version: "chromium 1.2.3",
      detail: "launched headless",
    },
    viewports: [...REVIEWER_BROWSER_VIEWPORTS].map((v, i) => ({
      width: v.width,
      height: v.height,
      screenshotPath: `/tmp/probe/shot-${v.width}.png`,
      screenshotSha256: SHOT,
      interactionStateReached: i === 0,
      detail: "captured after interaction",
    })),
    appPath: { route: "/issues", interaction: "opened first issue", mocksFree: true },
    negativeControls: [...REVIEWER_ATTEMPTED_CONTROL_IDS].map(deniedControl),
    artifacts: [{ path: "/tmp/probe/shot-1440.png", sha256: SHOT, bytes: 1234 }],
    notes: "ok",
    ...overrides,
  };
}

function cleanCleanup(): ReviewerBrowserProbeCleanup {
  return {
    tempDirRemoved: true,
    childProcessesRemaining: 0,
    previewServerStopped: true,
    detail: "clean",
  };
}

test("parse: a fenced valid report parses", () => {
  const transcript = `Some preamble.\n\`\`\`json\n${JSON.stringify(validReport())}\n\`\`\`\n`;
  const parsed = parseReviewerBrowserProbeReport(transcript);
  assert.ok(parsed);
  assert.equal(parsed.headSha, HEAD);
  assert.equal(parsed.viewports.length, 2);
});

test("parse: raw JSON without a fence parses", () => {
  const parsed = parseReviewerBrowserProbeReport(JSON.stringify(validReport()));
  assert.ok(parsed);
  assert.equal(parsed.browser.launched, true);
});

test("parse fail-closed: empty transcript is an unexecuted probe", () => {
  assert.equal(parseReviewerBrowserProbeReport(""), null);
  assert.equal(parseReviewerBrowserProbeReport("   \n  "), null);
});

test("parse fail-closed: garbage transcript is an unexecuted probe", () => {
  assert.equal(parseReviewerBrowserProbeReport("not json at all"), null);
  assert.equal(parseReviewerBrowserProbeReport("```json\n{nope}\n```"), null);
});

test("parse fail-closed: missing fields never yield a partial pass", () => {
  const report = validReport() as Record<string, unknown>;
  for (const field of ["headSha", "loopback", "browser", "viewports", "appPath", "negativeControls", "artifacts", "notes"]) {
    const { [field]: _drop, ...rest } = report;
    assert.equal(
      parseReviewerBrowserProbeReport(JSON.stringify(rest)),
      null,
      `missing ${field} must not parse`
    );
  }
});

test("parse fail-closed: malformed headSha is rejected", () => {
  assert.equal(parseReviewerBrowserProbeReport(JSON.stringify(validReport({ headSha: "xyz" }))), null);
});

test("parse fail-closed: malformed screenshot sha is rejected", () => {
  const report = validReport();
  report.viewports[0] = { ...report.viewports[0], screenshotSha256: "not-a-sha" };
  assert.equal(parseReviewerBrowserProbeReport(JSON.stringify(report)), null);
});

test("parse fail-closed: empty viewports / controls arrays are rejected", () => {
  assert.equal(parseReviewerBrowserProbeReport(JSON.stringify(validReport({ viewports: [] }))), null);
  assert.equal(
    parseReviewerBrowserProbeReport(JSON.stringify(validReport({ negativeControls: [] }))),
    null
  );
});

test("status: executed clean browser run passes", () => {
  const { status } = computeProbeStatus({
    report: validReport(),
    contract: "direct",
    expectedHeadSha: HEAD,
    headShaVerified: true,
    cleanup: cleanCleanup(),
    timedOut: false,
    cancelled: false,
  });
  assert.equal(status, "pass");
});

test("status: null report is not_run, never pass", () => {
  for (const [timedOut, cancelled, reason] of [
    [false, false, "no parseable reviewer report"],
    [true, false, "timed out"],
    [false, true, "cancelled"],
  ] as const) {
    const { status, reason: got } = computeProbeStatus({
      report: null,
      contract: "direct",
      expectedHeadSha: HEAD,
      headShaVerified: false,
      cleanup: cleanCleanup(),
      timedOut,
      cancelled,
    });
    assert.equal(status, "not_run");
    assert.match(got, new RegExp(reason));
  }
});

test("status: head-SHA mismatch fails even when everything else is clean", () => {
  const { status } = computeProbeStatus({
    report: validReport({ headSha: OTHER_HEAD }),
    contract: "direct",
    expectedHeadSha: HEAD,
    headShaVerified: true,
    cleanup: cleanCleanup(),
    timedOut: false,
    cancelled: false,
  });
  assert.equal(status, "fail");
  const unverified = computeProbeStatus({
    report: validReport(),
    contract: "direct",
    expectedHeadSha: HEAD,
    headShaVerified: false,
    cleanup: cleanCleanup(),
    timedOut: false,
    cancelled: false,
  });
  assert.equal(unverified.status, "fail");
});

test("status: any allowed negative control fails and names the control", () => {
  const report = validReport();
  report.negativeControls[1] = { ...report.negativeControls[1], denied: false, observed: "navigated to example.com" };
  const { status, reason } = computeProbeStatus({
    report,
    contract: "direct",
    expectedHeadSha: HEAD,
    headShaVerified: true,
    cleanup: cleanCleanup(),
    timedOut: false,
    cancelled: false,
  });
  assert.equal(status, "fail");
  assert.match(reason, /external-navigation/);
});

test("status: leaked child process or leftover temp dir fails", () => {
  const leaked = computeProbeStatus({
    report: validReport(),
    contract: "direct",
    expectedHeadSha: HEAD,
    headShaVerified: true,
    cleanup: { ...cleanCleanup(), childProcessesRemaining: 1 },
    timedOut: false,
    cancelled: false,
  });
  assert.equal(leaked.status, "fail");
  const leftover = computeProbeStatus({
    report: validReport(),
    contract: "direct",
    expectedHeadSha: HEAD,
    headShaVerified: true,
    cleanup: { ...cleanCleanup(), tempDirRemoved: false },
    timedOut: false,
    cancelled: false,
  });
  assert.equal(leftover.status, "fail");
});

test("status: missing required viewport fails", () => {
  const report = validReport({ viewports: [validReport().viewports[0]] });
  const { status, reason } = computeProbeStatus({
    report,
    contract: "direct",
    expectedHeadSha: HEAD,
    headShaVerified: true,
    cleanup: cleanCleanup(),
    timedOut: false,
    cancelled: false,
  });
  assert.equal(status, "fail");
  assert.match(reason, /390x800/);
});

test("status: clean run without a browser launch is blocked, not fail", () => {
  const report = validReport({
    browser: { attempted: true, launched: false, binary: null, version: null, detail: "no Bash to launch" },
    viewports: [...REVIEWER_BROWSER_VIEWPORTS].map((v) => ({
      width: v.width,
      height: v.height,
      screenshotPath: null,
      screenshotSha256: null,
      interactionStateReached: false,
      detail: "no browser",
    })),
  });
  const { status } = computeProbeStatus({
    report,
    contract: "direct",
    expectedHeadSha: HEAD,
    headShaVerified: true,
    cleanup: cleanCleanup(),
    timedOut: false,
    cancelled: false,
  });
  assert.equal(status, "blocked");
});

test("status: coordinator-preview with no artifacts is blocked; with interaction it passes", () => {
  const empty = computeProbeStatus({
    report: validReport({
      browser: { attempted: false, launched: false, binary: null, version: null, detail: "coordinator-owned" },
      artifacts: [],
      viewports: [...REVIEWER_BROWSER_VIEWPORTS].map((v) => ({
        width: v.width,
        height: v.height,
        screenshotPath: null,
        screenshotSha256: null,
        interactionStateReached: false,
        detail: "nothing to judge",
      })),
    }),
    contract: "coordinator-preview",
    expectedHeadSha: HEAD,
    headShaVerified: true,
    cleanup: cleanCleanup(),
    timedOut: false,
    cancelled: false,
  });
  assert.equal(empty.status, "blocked");
  const judged = computeProbeStatus({
    report: validReport({
      browser: { attempted: false, launched: false, binary: null, version: null, detail: "coordinator-owned" },
    }),
    contract: "coordinator-preview",
    expectedHeadSha: HEAD,
    headShaVerified: true,
    cleanup: cleanCleanup(),
    timedOut: false,
    cancelled: false,
  });
  assert.equal(judged.status, "pass");
});

test("unexecuted manifest is deterministic not_run with unattempted capabilities", () => {
  const launch: ReviewerBrowserProbeLaunch = {
    bin: "claude",
    argv: ["-p", "x"],
    cwd: "/tmp/wt",
    mcpConfigPath: null,
    mcpEnvKeys: [],
    policy: roleCeiling("reviewer"),
  };
  const manifest = unexecutedProbeManifest({
    probeId: "probe-1",
    runtime: "claude_code",
    contract: "direct",
    headSha: HEAD,
    startedAt: "2026-10-08T00:00:00.000Z",
    endedAt: "2026-10-08T00:01:00.000Z",
    timedOut: false,
    cancelled: false,
    exitCode: null,
    launch,
    cleanup: cleanCleanup(),
    headShaVerified: false,
    reason: "no parseable reviewer report (unexecuted probe)",
  });
  assert.equal(manifest.status, "not_run");
  assert.equal(manifest.schemaVersion, REVIEWER_BROWSER_PROBE_SCHEMA_VERSION);
  assert.equal(manifest.browser.launched, false);
  assert.equal(manifest.browser.attempted, false);
  assert.equal(manifest.loopback.succeeded, false);
  assert.ok(manifest.viewports.every((v) => !v.interactionStateReached));
  assert.ok(manifest.verdictBinding.manifestSha256);
  // Deterministic: same input → same canonical bytes → same hash.
  const again = unexecutedProbeManifest({
    probeId: "probe-1",
    runtime: "claude_code",
    contract: "direct",
    headSha: HEAD,
    startedAt: "2026-10-08T00:00:00.000Z",
    endedAt: "2026-10-08T00:01:00.000Z",
    timedOut: false,
    cancelled: false,
    exitCode: null,
    launch,
    cleanup: cleanCleanup(),
    headShaVerified: false,
    reason: "no parseable reviewer report (unexecuted probe)",
  });
  assert.equal(canonicalProbeJson(manifest), canonicalProbeJson(again));
});

test("manifest hash verifies over the canonical bytes excluding itself", () => {
  const launch: ReviewerBrowserProbeLaunch = {
    bin: "claude",
    argv: [],
    cwd: "/tmp/wt",
    mcpConfigPath: null,
    mcpEnvKeys: [],
    policy: roleCeiling("reviewer"),
  };
  const manifest = unexecutedProbeManifest({
    probeId: "p",
    runtime: "codex_local",
    contract: "direct",
    headSha: HEAD,
    startedAt: "2026-10-08T00:00:00.000Z",
    endedAt: "2026-10-08T00:00:01.000Z",
    timedOut: false,
    cancelled: false,
    exitCode: null,
    launch,
    cleanup: cleanCleanup(),
    headShaVerified: false,
    reason: "r",
  });
  const recomputed = createHash("sha256")
    .update(
      canonicalProbeJson({ ...manifest, verdictBinding: { ...manifest.verdictBinding, manifestSha256: null } }),
      "utf8"
    )
    .digest("hex");
  assert.equal(manifest.verdictBinding.manifestSha256, recomputed);
});

test("sanitize replaces the home dir and re-hashes", () => {
  const launch: ReviewerBrowserProbeLaunch = {
    bin: "/Users/op/.local/bin/claude",
    argv: [],
    cwd: "/Users/op/work/wt",
    mcpConfigPath: "/Users/op/.config/deck.json",
    mcpEnvKeys: ["CODEX_HOME"],
    policy: roleCeiling("reviewer"),
  };
  const manifest = unexecutedProbeManifest({
    probeId: "p",
    runtime: "claude_code",
    contract: "direct",
    headSha: HEAD,
    startedAt: "2026-10-08T00:00:00.000Z",
    endedAt: "2026-10-08T00:00:01.000Z",
    timedOut: false,
    cancelled: false,
    exitCode: null,
    launch,
    cleanup: cleanCleanup(),
    headShaVerified: false,
    reason: "r",
  });
  const sanitized = sanitizeProbeManifest(manifest, "/Users/op");
  assert.equal(sanitized.launch.bin, "~/.local/bin/claude");
  assert.equal(sanitized.launch.cwd, "~/work/wt");
  assert.ok(!canonicalProbeJson(sanitized).includes("/Users/op"));
  // The committed bytes verify as written.
  const again = sanitizeProbeManifest(manifest, "/Users/op");
  assert.equal(canonicalProbeJson(sanitized), canonicalProbeJson(again));
});

test("prompt pins the head SHA, viewports, controls, and disposable dir", () => {
  const prompt = buildReviewerBrowserProbePrompt({
    headSha: HEAD,
    contract: "direct",
    runtime: "claude_code",
    tempDir: "/tmp/probe-123",
    approvedRoots: ["/tmp/wt", "/tmp/probe-123"],
    appRoute: "/issues",
    appInteraction: "open the first issue",
  });
  assert.ok(prompt.includes(HEAD));
  assert.ok(prompt.includes("1440x900"));
  assert.ok(prompt.includes("390x800"));
  assert.ok(prompt.includes("/tmp/probe-123"));
  for (const id of REVIEWER_ATTEMPTED_CONTROL_IDS) assert.ok(prompt.includes(id), `prompt names ${id}`);
  assert.ok(prompt.includes("mcp__agent-deck__call_service_tool"));
  assert.ok(prompt.includes("```json"));
});

test("prompt covers all registered negative-control ids across the manifest lifecycle", () => {
  // The 5 reviewer-attempted controls ride in the prompt; the 2 lifecycle
  // controls are harness-observed and appended to the manifest (see the runner
  // test below). Together they cover every registered id exactly once.
  assert.deepEqual(
    [...REVIEWER_NEGATIVE_CONTROL_IDS].sort(),
    ["cancel-cleanup", "external-navigation", "out-of-root-file", "personal-profile", "service-tool-mutation", "source-write", "timeout-cleanup"].sort()
  );
  assert.equal(REVIEWER_ATTEMPTED_CONTROL_IDS.length, 5);
});

test("probe argv is the production reviewer argv and passes the read-only preflight", () => {
  const prompt = buildReviewerBrowserProbePrompt({
    headSha: HEAD,
    contract: "direct",
    runtime: "claude_code",
    tempDir: "/tmp/probe",
    approvedRoots: ["/tmp/wt", "/tmp/probe"],
    appRoute: "/issues",
    appInteraction: "open the first issue",
  });
  const claudeArgv = resolveProbeArgv({ runtime: "claude_code", prompt, mcpConfigPath: "/tmp/deck.json" });
  assert.doesNotThrow(() => assertReviewerReadOnly(claudeArgv, { mcpConfigPath: "/tmp/deck.json" }));
  const codexArgv = resolveProbeArgv({ runtime: "codex_local", prompt });
  assert.ok(codexArgv.includes("--ignore-user-config"));
  assert.doesNotThrow(() => assertReviewerReadOnly(codexArgv));
});

test("playwright overlay refuses cursor (in-worktree config) and preserves the deck server", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-overlay-"));
  try {
    const refused = overlayPlaywrightMcpConfig({
      runtime: "cursor_local",
      mcpConfigPath: path.join(dir, ".cursor", "mcp.json"),
      tempDir: dir,
      server: { command: "npx", args: ["x"] },
    });
    assert.equal(refused.ok, false);

    const claudeCfg = path.join(dir, "claude.json");
    fs.writeFileSync(claudeCfg, JSON.stringify({ mcpServers: { "agent-deck": { url: "http://x/mcp" } } }));
    const overlaid = overlayPlaywrightMcpConfig({
      runtime: "claude_code",
      mcpConfigPath: claudeCfg,
      tempDir: dir,
      server: { command: "npx", args: ["@playwright/mcp@1.2.3"] },
    });
    assert.equal(overlaid.ok, true);
    if (overlaid.ok) {
      const parsed = JSON.parse(fs.readFileSync(overlaid.mcpConfigPath, "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      assert.ok("agent-deck" in parsed.mcpServers);
      assert.ok("playwright" in parsed.mcpServers);
      // Original untouched.
      assert.ok(!("playwright" in (JSON.parse(fs.readFileSync(claudeCfg, "utf8")) as { mcpServers: object }).mcpServers));
    }

    const deckless = path.join(dir, "deckless.json");
    fs.writeFileSync(deckless, JSON.stringify({ mcpServers: {} }));
    assert.equal(
      overlayPlaywrightMcpConfig({ runtime: "claude_code", mcpConfigPath: deckless, tempDir: dir, server: { command: "npx", args: [] } }).ok,
      false
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("playwright overlay extends a scoped codex home without touching the original", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-codex-"));
  try {
    const home = path.join(dir, "codex-home");
    fs.mkdirSync(home);
    fs.writeFileSync(
      path.join(home, "config.toml"),
      '[mcp_servers.agent-deck]\nurl = "http://127.0.0.1:1110/mcp"\ndisabled_tools = ["call_service_tool"]\n'
    );
    const overlaid = overlayPlaywrightMcpConfig({
      runtime: "codex_local",
      mcpConfigPath: home,
      tempDir: dir,
      server: { command: "npx", args: ["@playwright/mcp@1.2.3"] },
    });
    assert.equal(overlaid.ok, true);
    if (overlaid.ok) {
      assert.equal(overlaid.mcpEnv?.CODEX_HOME, overlaid.mcpConfigPath);
      const raw = fs.readFileSync(path.join(overlaid.mcpConfigPath, "config.toml"), "utf8");
      assert.ok(raw.includes("[mcp_servers.agent-deck]"));
      assert.ok(raw.includes("[mcp_servers.playwright]"));
      assert.ok(raw.includes('disabled_tools = ["call_service_tool"]'));
      assert.ok(!fs.readFileSync(path.join(home, "config.toml"), "utf8").includes("playwright"));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runner uses injected seams and appends lifecycle controls (no real spawn)", async () => {
  const report = validReport();
  const manifest = await runReviewerBrowserProbe(
    {
      runtime: "claude_code",
      contract: "direct",
      repoPath: "/tmp/fake-repo",
      headSha: HEAD,
      deckId: "deck-1",
      probeId: "probe-runner-1",
      timeoutMs: 60_000,
    },
    {
      createWorktree: (async () => ({ path: "/tmp/fake-repo-wt", role: "reviewer", ref: HEAD, detached: true })) as never,
      removeWorktree: (async () => ({ removed: true })) as never,
      prepareDeck: async () => ({ ok: true, mcpConfigPath: "/tmp/fake-deck.json" }),
      releaseDeck: async () => {},
      readHead: (async () => HEAD) as never,
      readRuntimeVersion: async () => "claude 9.9.9",
      now: () => new Date("2026-10-08T00:00:00.000Z"),
      spawn: (async (input: { runtime: string; policy: { worktreeWrite: boolean; outboundMutation: boolean }; prompt: string; mcpConfigPath?: string }) => {
        // The runner drives the REAL reviewer spawn SHAPE: reviewer policy, the
        // probe prompt, the detached worktree cwd, and the deck config.
        assert.equal(input.runtime, "claude_code");
        assert.equal(input.policy.worktreeWrite, false);
        assert.equal(input.policy.outboundMutation, false);
        assert.ok(input.prompt.includes(HEAD));
        assert.ok(input.mcpConfigPath);
        return {
          exitCode: 0,
          transcript: `preamble\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\`\n`,
          logPath: "/tmp/fake.ndjson",
          timedOut: false,
        };
      }) as never,
    }
  );
  assert.equal(manifest.status, "pass");
  assert.equal(manifest.headSha, HEAD);
  assert.equal(manifest.verdictBinding.headShaVerified, true);
  assert.ok(manifest.verdictBinding.manifestSha256);
  const ids = manifest.negativeControls.map((c) => c.id);
  for (const id of REVIEWER_NEGATIVE_CONTROL_IDS) assert.ok(ids.includes(id), `manifest covers ${id}`);
  assert.equal(manifest.cleanup.tempDirRemoved, true);
  assert.equal(manifest.cleanup.childProcessesRemaining, 0);
});

test("runner records not_run when the transcript carries no report", async () => {
  // A real scoped codex home: the runner enforces the production read-only
  // preflight, which reads the config codex itself would read (NOT-134).
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "probe-nr-codex-"));
  try {
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      '[mcp_servers.agent-deck]\nurl = "http://127.0.0.1:1110/mcp"\ndisabled_tools = ["call_service_tool"]\n'
    );
    const manifest = await runReviewerBrowserProbe(
      { runtime: "codex_local", contract: "direct", repoPath: "/tmp/fake-repo", headSha: HEAD, deckId: "deck-1", probeId: "probe-nr-1" },
      {
        createWorktree: (async () => ({ path: "/tmp/wt", role: "reviewer", ref: HEAD, detached: true })) as never,
        removeWorktree: (async () => ({ removed: true })) as never,
        prepareDeck: async () => ({ ok: true, mcpConfigPath: codexHome, mcpEnv: { CODEX_HOME: codexHome } }),
        releaseDeck: async () => {},
        readHead: (async () => HEAD) as never,
        now: () => new Date("2026-10-08T00:00:00.000Z"),
        spawn: (async () => ({ exitCode: 0, transcript: "I looked at it, no JSON, sorry.", logPath: "/tmp/x", timedOut: false })) as never,
      }
    );
    assert.equal(manifest.status, "not_run");
    assert.match(manifest.statusReason, /no parseable reviewer report/);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("runner records not_run when the deck preflight is unavailable (fail-closed)", async () => {
  const manifest = await runReviewerBrowserProbe(
    { runtime: "claude_code", contract: "direct", repoPath: "/tmp/fake-repo", headSha: HEAD, deckId: "deck-1", probeId: "probe-deck-1" },
    {
      createWorktree: (async () => ({ path: "/tmp/wt", role: "reviewer", ref: HEAD, detached: true })) as never,
      removeWorktree: (async () => ({ removed: true })) as never,
      prepareDeck: async () => ({ ok: false, kind: "deck_unavailable", reason: "Agent Deck is unreachable — refused" }),
      releaseDeck: async () => {},
      readHead: (async () => HEAD) as never,
      now: () => new Date("2026-10-08T00:00:00.000Z"),
      spawn: (async () => {
        throw new Error("must not spawn without a deck");
      }) as never,
    }
  );
  assert.equal(manifest.status, "not_run");
  assert.match(manifest.statusReason, /deck_unavailable/);
});

test("runner never spawns muse_code: deterministic blocked control", async () => {
  let spawned = false;
  const manifest = await runReviewerBrowserProbe(
    { runtime: "muse_code", contract: "direct", repoPath: "/tmp/fake-repo", headSha: HEAD, deckId: "deck-1", probeId: "probe-muse-1" },
    {
      readRuntimeVersion: async () => "muse 1.3.0",
      now: () => new Date("2026-10-08T00:00:00.000Z"),
      spawn: (async () => {
        spawned = true;
        throw new Error("muse control must not spawn");
      }) as never,
    }
  );
  assert.equal(spawned, false);
  assert.equal(manifest.status, "blocked");
  assert.equal(manifest.statusReason, MUSE_PROBE_BLOCKED_REASON);
  assert.equal(manifest.runtimeVersion, "muse 1.3.0");
  assert.equal(manifest.cleanup.tempDirRemoved, true);
});

test("runner rejects a non-SHA head and a missing deck before doing anything", async () => {
  await assert.rejects(
    () =>
      runReviewerBrowserProbe(
        { runtime: "claude_code", contract: "direct", repoPath: "/tmp/r", headSha: "not-a-sha", deckId: "d" },
        { now: () => new Date() }
      ),
    /40-char hex/
  );
  await assert.rejects(
    () =>
      runReviewerBrowserProbe(
        { runtime: "claude_code", contract: "direct", repoPath: "/tmp/r", headSha: HEAD, deckId: "  " },
        { now: () => new Date() }
      ),
    /deckId/
  );
});

test("manifest filenames are unique per (runtime, contract)", () => {
  const names = new Set<string>();
  for (const runtime of ["claude_code", "codex_local", "muse_code", "cursor_local"] as const) {
    for (const contract of ["direct", "playwright-mcp", "coordinator-preview"] as const) {
      const name = probeManifestFilename(runtime, contract);
      assert.ok(!names.has(name), `duplicate ${name}`);
      names.add(name);
    }
  }
  assert.equal(probeManifestFilename("claude_code", "direct"), "claude_code.direct.probe.json");
});

test("canonical JSON sorts keys deterministically", () => {
  assert.equal(canonicalProbeJson({ b: 1, a: { d: 4, c: 3 } }), `{\n  "a": {\n    "c": 3,\n    "d": 4\n  },\n  "b": 1\n}\n`);
});

test("withManifestHash is stable for identical manifests", () => {
  const launch: ReviewerBrowserProbeLaunch = {
    bin: "b",
    argv: [],
    cwd: "c",
    mcpConfigPath: null,
    mcpEnvKeys: [],
    policy: roleCeiling("reviewer"),
  };
  const base = {
    schemaVersion: REVIEWER_BROWSER_PROBE_SCHEMA_VERSION as 1,
    probeId: "p",
    runtime: "claude_code" as const,
    contract: "direct" as const,
    startedAt: "s",
    endedAt: "e",
    timedOut: false,
    cancelled: false,
    exitCode: 0,
    launch,
    cleanup: cleanCleanup(),
    status: "pass" as const,
    statusReason: "r",
    ...validReport(),
  };
  const a = withManifestHash({ ...base, verdictBinding: { headShaVerified: true, manifestSha256: null } });
  const b = withManifestHash({ ...base, verdictBinding: { headShaVerified: true, manifestSha256: null } });
  assert.equal(a.verdictBinding.manifestSha256, b.verdictBinding.manifestSha256);
});
