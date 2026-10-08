// packages/server/src/coordinator/reviewer-visual-evidence.test.ts
//
// NOT-384: the UI-affecting classifier (pinned against visual.yml), the pure
// evidence classifier, worktree staging + clean-check exclusion + cleanup, the
// resolve orchestration with a faked fetcher, and the merge-gate reader.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { VisualEvidenceFetcher } from "./reviewer-visual-evidence.js";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not384-"));

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("../repository/issues.js");
const { createIssueArtifact } = await import("../repository/artifacts.js");
const { listArtifactsForIssueByKind } = await import("../repository/artifacts-for-issue.js");
const { isWorktreeClean, REVIEWER_VISUAL_STAGING_DIR_NAME } = await import(
  "../adapters/git-worktree.js"
);
const {
  VISUAL_WORKFLOW_PATHS,
  VISUAL_ARTIFACT_NAMES,
  VISUAL_EVIDENCE_ARTIFACT_KIND,
  isUiAffectingChange,
  classifyVisualEvidence,
  githubVisualEvidenceFetcher,
  resolveReviewerVisualEvidence,
  stageVisualArtifacts,
  cleanupStagedVisualArtifacts,
  readVisualDiffSummary,
  reviewerVisualStagingDir,
  toReviewerVisualEvidenceInput,
  readVisualEvidenceHold,
} = await import("./reviewer-visual-evidence.js");

before(() => migrate());
beforeEach(() => {
  getDb().exec(`
    DELETE FROM work_items;
    DELETE FROM human_actions;
    DELETE FROM workflow_events;
    DELETE FROM findings;
    DELETE FROM review_publications;
    DELETE FROM worker_sessions;
    DELETE FROM artifacts;
    DELETE FROM usage_events;
    DELETE FROM workflow_instances;
    DELETE FROM issues;
  `);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeIssue(): string {
  return createIssue({
    title: "UI work",
    description: "d",
    acceptanceCriteria: "It renders",
    repo: "acme/app",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
    autoMerge: true,
  }).id;
}

// The classifier answers true for one representative path per pattern in the
// shared path set — each entry proven, not just the set as a whole.
test("NOT-384: classifier returns true for each path in the shared path set", () => {
  const representative: Record<string, string> = {
    "apps/web/**": "apps/web/src/routes/issues.tsx",
    "packages/shared/**": "packages/shared/src/types.ts",
    "ui-screenshots.json": "ui-screenshots.json",
    "scripts/ci-visual/**": "scripts/ci-visual/capture.mts",
    ".github/workflows/visual.yml": ".github/workflows/visual.yml",
  };
  assert.deepEqual(Object.keys(representative).sort(), [...VISUAL_WORKFLOW_PATHS].sort());
  for (const [pattern, file] of Object.entries(representative)) {
    assert.equal(isUiAffectingChange([file]), true, `${pattern} must match ${file}`);
  }
});

test("NOT-384: classifier returns false for docs-only and server-only changes", () => {
  assert.equal(isUiAffectingChange(["docs/guide.md", "README.md", "CHANGELOG.md"]), false);
  assert.equal(
    isUiAffectingChange(["packages/server/src/coordinator/routing.ts", "packages/server/package.json"]),
    false
  );
  assert.equal(isUiAffectingChange([]), false);
  assert.equal(isUiAffectingChange(["", "   "]), false);
});

test("NOT-384: classifier matches directories, ./ prefixes, and mixed lists", () => {
  assert.equal(isUiAffectingChange(["apps/web"]), true);
  assert.equal(isUiAffectingChange(["./packages/shared/src/x.ts"]), true);
  assert.equal(isUiAffectingChange(["docs/a.md", "apps/web/dist/app.js"]), true);
  // Near misses stay non-UI: a differently-named workflow, a nested config.
  assert.equal(isUiAffectingChange([".github/workflows/ci.yml"]), false);
  assert.equal(isUiAffectingChange(["apps/web-ui/x.ts"]), false);
  assert.equal(isUiAffectingChange(["nested/ui-screenshots.json"]), false);
});

// The shared path set equals the `paths` list in visual.yml — both trigger
// blocks, in order. A workflow edit without a classifier edit (or vice versa)
// fails here instead of silently desyncing what CI captures and what Dealer
// treats as UI-affecting.
test("NOT-384: shared path set equals the paths list in visual.yml", () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const workflowPath = path.resolve(testDir, "..", "..", "..", "..", ".github", "workflows", "visual.yml");
  const lines = fs.readFileSync(workflowPath, "utf8").split("\n");
  const blocks: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]!.match(/^(\s*)paths:\s*$/);
    if (!header) continue;
    const indent = header[1]!.length;
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const item = lines[j]!.match(/^\s+-\s*["']([^"']+)["']\s*(?:#.*)?$/);
      if (item && lines[j]!.search(/\S/) > indent) {
        block.push(item[1]!);
        continue;
      }
      if (/^\s*$/.test(lines[j]!)) continue;
      break;
    }
    if (block.length > 0) blocks.push(block);
  }
  assert.equal(blocks.length, 2, `expected pull_request + push paths blocks, found ${blocks.length}`);
  for (const block of blocks) {
    assert.deepEqual(block, [...VISUAL_WORKFLOW_PATHS]);
  }
});

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);

test("NOT-384: evidence classification — available", () => {
  assert.equal(
    classifyVisualEvidence({
      uiAffecting: true,
      headSha: HEAD,
      run: { databaseId: 7, headSha: HEAD, conclusion: "success", status: "completed" },
      artifactNames: ["ui-screenshots", "ui-baseline", "ui-diff"],
    }),
    "available"
  );
  // Extra artifacts and success-adjacent conclusions still count.
  assert.equal(
    classifyVisualEvidence({
      uiAffecting: true,
      headSha: HEAD,
      run: { databaseId: 7, headSha: HEAD, conclusion: "neutral", status: "completed" },
      artifactNames: ["ui-screenshots", "ui-baseline", "ui-diff", "extra"],
    }),
    "available"
  );
});

test("NOT-384: evidence classification — missing", () => {
  const base = { uiAffecting: true, headSha: HEAD } as const;
  // No run at all (the NOT-380 case: Visual did not even run).
  assert.equal(classifyVisualEvidence({ ...base, run: null, artifactNames: [] }), "missing");
  // A run for a different SHA is never available, however green.
  assert.equal(
    classifyVisualEvidence({
      ...base,
      run: { databaseId: 7, headSha: OTHER, conclusion: "success", status: "completed" },
      artifactNames: ["ui-screenshots", "ui-baseline", "ui-diff"],
    }),
    "missing"
  );
  // Successful run but an artifact short.
  assert.equal(
    classifyVisualEvidence({
      ...base,
      run: { databaseId: 7, headSha: HEAD, conclusion: "success", status: "completed" },
      artifactNames: ["ui-screenshots", "ui-baseline"],
    }),
    "missing"
  );
  // Still running: no usable captures yet.
  assert.equal(
    classifyVisualEvidence({
      ...base,
      run: { databaseId: 7, headSha: HEAD, conclusion: null, status: "in_progress" },
      artifactNames: [],
    }),
    "missing"
  );
  // Completed with an unrecognized conclusion: not proven failed, not usable.
  assert.equal(
    classifyVisualEvidence({
      ...base,
      run: { databaseId: 7, headSha: HEAD, conclusion: "stale", status: "completed" },
      artifactNames: ["ui-screenshots", "ui-baseline", "ui-diff"],
    }),
    "missing"
  );
});

test("NOT-384: evidence classification — failed", () => {
  for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", "startup_failure"]) {
    assert.equal(
      classifyVisualEvidence({
        uiAffecting: true,
        headSha: HEAD,
        run: { databaseId: 7, headSha: HEAD, conclusion, status: "completed" },
        artifactNames: ["ui-screenshots", "ui-baseline", "ui-diff"],
      }),
      "failed",
      `conclusion ${conclusion} must read as failed`
    );
  }
});

test("NOT-384: evidence classification — not_applicable", () => {
  assert.equal(
    classifyVisualEvidence({ uiAffecting: false, headSha: HEAD, run: null, artifactNames: [] }),
    "not_applicable"
  );
  // Non-UI heads stay not_applicable even when a failed run exists.
  assert.equal(
    classifyVisualEvidence({
      uiAffecting: false,
      headSha: HEAD,
      run: { databaseId: 7, headSha: HEAD, conclusion: "failure", status: "completed" },
      artifactNames: [],
    }),
    "not_applicable"
  );
});

test("NOT-384: github fetcher resolves only exact-SHA runs", async () => {
  const fetcher = githubVisualEvidenceFetcher({
    listWorkflowRunsForCommit: async () => [
      { databaseId: 9, headSha: OTHER, conclusion: "success", status: "completed" },
      { databaseId: 8, headSha: HEAD, conclusion: "success", status: "completed" },
    ],
    downloadRunArtifact: async () => {},
  } as never);
  assert.ok(fetcher);
  const run = await fetcher!.findRunForHead({ cwd: "/repo", headSha: HEAD });
  assert.equal(run?.databaseId, 8);
  // Stale-only listing: no run for this head.
  const staleOnly = githubVisualEvidenceFetcher({
    listWorkflowRunsForCommit: async () => [
      { databaseId: 9, headSha: OTHER, conclusion: "success", status: "completed" },
    ],
    downloadRunArtifact: async () => {},
  } as never);
  assert.equal(await staleOnly!.findRunForHead({ cwd: "/repo", headSha: HEAD }), null);
});

test("NOT-384: github fetcher is null when the adapter predates the lookup methods", () => {
  assert.equal(githubVisualEvidenceFetcher({} as never), null);
  assert.equal(
    githubVisualEvidenceFetcher({ listWorkflowRunsForCommit: async () => [] } as never),
    null
  );
});

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not384-wt-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

const SUMMARY = "## UI diff (base vs head, report-only)\n\nhead: `aaa`\n\nbase: `bbb`\n";

function writeFixtureStore(storeDir: string): void {
  for (const name of VISUAL_ARTIFACT_NAMES) {
    const dir = path.join(storeDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "issues-home-1440x900.png"), `fake-png-${name}`);
    fs.writeFileSync(path.join(dir, "issues-home-390x800.png"), `fake-png-${name}`);
  }
  fs.writeFileSync(path.join(storeDir, "ui-diff", "SUMMARY.md"), SUMMARY);
}

test("NOT-384: staged artifacts land under the reviewer worktree, stay clean, and clean up", async () => {
  const worktree = initRepo();
  try {
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not384-store-"));
    writeFixtureStore(storeDir);
    const staged = stageVisualArtifacts({ worktreePath: worktree, storeDir });
    try {
      assert.equal(staged.stagedDir, reviewerVisualStagingDir(worktree));
      assert.ok(staged.stagedDir.startsWith(worktree + path.sep));
      assert.ok(staged.screenshotsDir.startsWith(staged.stagedDir + path.sep));
      assert.ok(staged.baselineDir.startsWith(staged.stagedDir + path.sep));
      assert.ok(staged.diffDir.startsWith(staged.stagedDir + path.sep));
      assert.equal(
        fs.readFileSync(path.join(staged.screenshotsDir, "issues-home-1440x900.png"), "utf8"),
        "fake-png-ui-screenshots"
      );
      assert.equal(staged.summaryPath, path.join(staged.diffDir, "SUMMARY.md"));
      // Read-only copy: no write bit on staged files.
      for (const name of VISUAL_ARTIFACT_NAMES) {
        const mode = fs.statSync(path.join(staged.stagedDir, name, "issues-home-1440x900.png")).mode;
        assert.equal(mode & 0o222, 0, `${name} capture must be read-only`);
      }
      // The worktree still reports clean with staged evidence present.
      assert.equal(await isWorktreeClean(worktree), true);
      // Controls: the exclusion is narrow — other untracked files and real
      // modifications still read as dirty.
      fs.writeFileSync(path.join(worktree, "scratch.txt"), "x\n");
      assert.equal(await isWorktreeClean(worktree), false);
      fs.rmSync(path.join(worktree, "scratch.txt"));
      fs.writeFileSync(path.join(worktree, "README.md"), "changed\n");
      assert.equal(await isWorktreeClean(worktree), false);
      git(worktree, "checkout", "--", "README.md");
      assert.equal(await isWorktreeClean(worktree), true);
    } finally {
      cleanupStagedVisualArtifacts(worktree);
    }
    assert.equal(fs.existsSync(path.join(worktree, REVIEWER_VISUAL_STAGING_DIR_NAME)), false);
    assert.equal(await isWorktreeClean(worktree), true);
    // Cleanup is idempotent.
    cleanupStagedVisualArtifacts(worktree);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("NOT-384: diff summary reads bounded, and null when absent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not384-summary-"));
  try {
    assert.equal(readVisualDiffSummary(dir), null);
    fs.writeFileSync(path.join(dir, "SUMMARY.md"), SUMMARY);
    assert.equal(readVisualDiffSummary(dir), SUMMARY.trim());
    assert.equal(readVisualDiffSummary(dir, 10)?.length, 10 + "\n… (truncated, full file in the staged ui-diff directory)".length);
    assert.match(readVisualDiffSummary(dir, 10)!, /truncated/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fixtureFetcher(opts: {
  run?: { databaseId: number; headSha: string; conclusion: string | null; status: string | null } | null;
  failDownload?: string[];
  failLookup?: boolean;
}): VisualEvidenceFetcher & { calls: { downloads: string[] } } {
  const calls = { downloads: [] as string[] };
  return {
    calls,
    async findRunForHead() {
      if (opts.failLookup) throw new Error("gh exploded");
      return opts.run === undefined
        ? { databaseId: 42, headSha: HEAD, conclusion: "success", status: "completed" }
        : opts.run;
    },
    async downloadArtifact({ name, destDir }) {
      calls.downloads.push(name);
      if (opts.failDownload?.includes(name)) throw new Error(`no such artifact ${name}`);
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(path.join(destDir, "issues-home-1440x900.png"), `fake-png-${name}`);
      fs.writeFileSync(path.join(destDir, "issues-home-390x800.png"), `fake-png-${name}`);
      if (name === "ui-diff") fs.writeFileSync(path.join(destDir, "SUMMARY.md"), SUMMARY);
    },
  };
}

test("NOT-384: resolve records not_applicable for non-UI heads without touching GitHub", async () => {
  const issueId = makeIssue();
  const worktree = initRepo();
  try {
    const fetcher = fixtureFetcher({});
    const resolved = await resolveReviewerVisualEvidence({
      issueId,
      worktreePath: worktree,
      baseSha: "c".repeat(40),
      headSha: HEAD,
      changedFiles: ["packages/server/src/x.ts"],
      github: {} as never,
      fetcher,
    });
    assert.equal(resolved.state, "not_applicable");
    assert.equal(resolved.uiAffecting, false);
    assert.equal(resolved.staged, null);
    assert.deepEqual(fetcher.calls.downloads, []);
    assert.equal(toReviewerVisualEvidenceInput(resolved), undefined);
    const rows = listArtifactsForIssueByKind(issueId, VISUAL_EVIDENCE_ARTIFACT_KIND);
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0]!.contentJson!).state, "not_applicable");
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("NOT-384: resolve stages available evidence and records the run", async () => {
  const issueId = makeIssue();
  const worktree = initRepo();
  try {
    const resolved = await resolveReviewerVisualEvidence({
      issueId,
      worktreePath: worktree,
      baseSha: "c".repeat(40),
      headSha: HEAD,
      changedFiles: ["apps/web/src/app.tsx"],
      github: {} as never,
      fetcher: fixtureFetcher({}),
    });
    assert.equal(resolved.state, "available");
    assert.equal(resolved.runId, 42);
    assert.deepEqual(resolved.artifactNames, ["ui-screenshots", "ui-baseline", "ui-diff"]);
    assert.ok(resolved.staged);
    assert.ok(resolved.staged!.stagedDir.startsWith(worktree + path.sep));
    assert.equal(resolved.summary, SUMMARY.trim());
    assert.equal(resolved.files!["ui-diff"].total, 3);
    assert.equal(await isWorktreeClean(worktree), true);
    const input = toReviewerVisualEvidenceInput(resolved)!;
    assert.equal(input.state, "available");
    assert.equal(input.staged, resolved.staged);
    const rows = listArtifactsForIssueByKind(issueId, VISUAL_EVIDENCE_ARTIFACT_KIND);
    assert.equal(rows.length, 1);
    const content = JSON.parse(rows[0]!.contentJson!);
    assert.equal(content.state, "available");
    assert.equal(content.headSha, HEAD);
    assert.ok(rows[0]!.blobPath, "Dealer storage path is recorded");
    assert.ok(fs.existsSync(path.join(rows[0]!.blobPath!, "ui-diff", "SUMMARY.md")));
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("NOT-384: resolve maps every failure to missing or failed, never throws", async () => {
  const worktree = initRepo();
  try {
    // No run for the head.
    const noRun = await resolveReviewerVisualEvidence({
      issueId: makeIssue(),
      worktreePath: worktree,
      baseSha: "c".repeat(40),
      headSha: HEAD,
      changedFiles: ["apps/web/src/app.tsx"],
      github: {} as never,
      fetcher: fixtureFetcher({ run: null }),
    });
    assert.equal(noRun.state, "missing");
    assert.equal(noRun.staged, null);
    assert.match(noRun.reason!, /no Visual workflow run/);
    // Failed run: no downloads attempted, nothing staged.
    const failing = fixtureFetcher({
      run: { databaseId: 43, headSha: HEAD, conclusion: "failure", status: "completed" },
    });
    const failed = await resolveReviewerVisualEvidence({
      issueId: makeIssue(),
      worktreePath: worktree,
      baseSha: "c".repeat(40),
      headSha: HEAD,
      changedFiles: ["apps/web/src/app.tsx"],
      github: {} as never,
      fetcher: failing,
    });
    assert.equal(failed.state, "failed");
    assert.equal(failed.runId, 43);
    assert.deepEqual(failing.calls.downloads, []);
    assert.match(failed.reason!, /concluded failure/);
    // Partial artifacts: missing, naming the absent one.
    const partial = await resolveReviewerVisualEvidence({
      issueId: makeIssue(),
      worktreePath: worktree,
      baseSha: "c".repeat(40),
      headSha: HEAD,
      changedFiles: ["apps/web/src/app.tsx"],
      github: {} as never,
      fetcher: fixtureFetcher({ failDownload: ["ui-diff"] }),
    });
    assert.equal(partial.state, "missing");
    assert.match(partial.reason!, /ui-diff/);
    // Lookup error and unavailable lookup both degrade to missing.
    const lookupError = await resolveReviewerVisualEvidence({
      issueId: makeIssue(),
      worktreePath: worktree,
      baseSha: "c".repeat(40),
      headSha: HEAD,
      changedFiles: ["apps/web/src/app.tsx"],
      github: {} as never,
      fetcher: fixtureFetcher({ failLookup: true }),
    });
    assert.equal(lookupError.state, "missing");
    assert.match(lookupError.reason!, /lookup failed/);
    const unavailable = await resolveReviewerVisualEvidence({
      issueId: makeIssue(),
      worktreePath: worktree,
      baseSha: "c".repeat(40),
      headSha: HEAD,
      changedFiles: ["apps/web/src/app.tsx"],
      github: {} as never,
    });
    assert.equal(unavailable.state, "missing");
    assert.match(unavailable.reason!, /unavailable/);
    // Unknown changed files fail closed: UI-affecting + missing.
    const unknown = await resolveReviewerVisualEvidence({
      issueId: makeIssue(),
      worktreePath: worktree,
      baseSha: "c".repeat(40),
      headSha: HEAD,
      changedFiles: null,
      github: {} as never,
      fetcher: fixtureFetcher({}),
    });
    assert.equal(unknown.uiAffecting, true);
    assert.equal(unknown.state, "missing");
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("NOT-384: gate reader holds only UI heads with missing/failed evidence at this head", () => {
  const issueId = makeIssue();
  assert.equal(readVisualEvidenceHold(issueId, HEAD), null);
  createIssueArtifact({
    issueId,
    kind: VISUAL_EVIDENCE_ARTIFACT_KIND,
    content: { headSha: HEAD, uiAffecting: true, state: "missing", reason: "no run", runId: null, artifactNames: ["ui-screenshots"] },
    author: "system",
  });
  const hold = readVisualEvidenceHold(issueId, HEAD)!;
  assert.equal(hold.state, "missing");
  assert.equal(hold.headSha, HEAD);
  assert.deepEqual(hold.missingArtifacts, ["ui-baseline", "ui-diff"]);
  assert.equal(readVisualEvidenceHold(issueId, OTHER), null);
  // A newer available record for a new head releases the old hold.
  createIssueArtifact({
    issueId,
    kind: VISUAL_EVIDENCE_ARTIFACT_KIND,
    content: { headSha: OTHER, uiAffecting: true, state: "available", runId: 1, artifactNames: [...VISUAL_ARTIFACT_NAMES] },
    author: "system",
  });
  assert.equal(readVisualEvidenceHold(issueId, OTHER), null);
  // Failed names every artifact as unusable.
  const failedIssue = makeIssue();
  createIssueArtifact({
    issueId: failedIssue,
    kind: VISUAL_EVIDENCE_ARTIFACT_KIND,
    content: { headSha: HEAD, uiAffecting: true, state: "failed", reason: "boom", runId: 9, artifactNames: [] },
    author: "system",
  });
  assert.deepEqual(readVisualEvidenceHold(failedIssue, HEAD)!.missingArtifacts, [...VISUAL_ARTIFACT_NAMES]);
  // Unreadable and non-UI records never hold.
  const weirdIssue = makeIssue();
  createIssueArtifact({ issueId: weirdIssue, kind: VISUAL_EVIDENCE_ARTIFACT_KIND, author: "system" });
  assert.equal(readVisualEvidenceHold(weirdIssue, HEAD), null);
  const nonUiIssue = makeIssue();
  createIssueArtifact({
    issueId: nonUiIssue,
    kind: VISUAL_EVIDENCE_ARTIFACT_KIND,
    content: { headSha: HEAD, uiAffecting: false, state: "missing" },
    author: "system",
  });
  assert.equal(readVisualEvidenceHold(nonUiIssue, HEAD), null);
});
