# Issue Coordination — Coordinator Implementation Plan

**Goal:** Build the developer–reviewer state machine that actually runs an issue: worktree-isolated developer and reviewer sessions, SHA-bound handoff verification via `git`/`gh`, outcome routing (approved/changes_requested/escalated/attempts_exhausted + every failure-mode path), crash recovery, and the reflect trigger on final review completion.

**Depends on:** Plan 1 (`docs/2026-09-10-issue-coordination-data-model.md`) — all 10 tasks must be complete. This plan adds no new tables; it's pure orchestration logic on top of the `issues`/`worker_sessions`/`workflow_instances`/`workflow_events`/`human_actions`/`findings` repositories.

**Spec:** `docs/2026-09-10-issue-centric-coordination-design.md` (Coordinator, Testing sections)

**Tech Stack:** Same as Plan 1 — TypeScript, `node:test`/`node:assert/strict` via `npx tsx --test`, real `git` subprocess calls in tests (fast, deterministic, no network), no `gh`/no real agent CLI spawn in automated tests (those are manually verified — see each task's "Manual verification" note).

## Global Constraints

- No dual-write to legacy `runs`/`events`/`artifacts` tables — this plan writes only through the Plan 1 repositories.
- Every subprocess-facing function that isn't deterministically testable offline (`gh` calls, real agent CLI spawns) is a thin wrapper around a pure, fully-tested parsing/decision function — the wrapper itself gets a "Manual verification" step instead of an automated test, matching how this repo already treats `spawnCli` (untested directly) vs `claude-args.ts`/`codex-args.ts` (fully tested).
- The coordinator orchestrator takes its `git`/`github`/spawn dependencies as parameters (dependency injection), not as hard-coded imports — this is what makes the state machine itself fully unit-testable with fakes, per the spec's Testing section ("fake GitHub/Git wrappers so no network/real GitHub calls are needed").
- `git`/`gh` subprocess calls use `execFile` (argv array), never a shell string — no command injection surface, matching the spec's `--body-file` requirement for review bodies.
- Reuse `spawnCli`/`resolveClaudeBin`/`resolveCursorBin`/`resolveCodexBin` from the existing runner plumbing; do not reimplement process spawning.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/server/src/adapters/git-worktree.ts` (new) | `git worktree add/remove`, `git status --porcelain`, `git merge-base`, per-repo lock |
| `packages/server/src/adapters/git-worktree.test.ts` (new) | Real-git tests against a temp repo |
| `packages/server/src/adapters/github.ts` (new) | `gh pr view`/`gh pr review` wrapper; JSON parsing is pure and tested, the exec call is not |
| `packages/server/src/adapters/github.test.ts` (new) | Parser tests against fixture JSON |
| `packages/server/src/coordinator/reviewer-result.ts` (new) | `ReviewerResult` schema + JSON-fence parser |
| `packages/server/src/coordinator/prompts.ts` (new) | `buildDeveloperPrompt`, `buildReviewerPrompt` |
| `packages/server/src/coordinator/routing.ts` (new) | Pure outcome-routing decision functions — the state machine's brain |
| `packages/server/src/coordinator/args.ts` (new) | Per-runtime, per-role CLI arg builders (developer/reviewer × claude/cursor/codex) |
| `packages/server/src/coordinator/spawn.ts` (new) | `spawnDeveloperSession`/`spawnReviewerSession` — dispatch by runtime, call `spawnCli` |
| `packages/server/src/coordinator/session-lifecycle.ts` (new) | The orchestrator: steps 1–7 of the spec's Session lifecycle |
| `packages/server/src/coordinator/dispatcher.ts` (new) | Poll loop, compare-and-set claim, stale-heartbeat/worktree crash recovery |
| `packages/server/src/coordinator/reflect-trigger.ts` (new) | Reflect-on-final-review-complete wiring |

---

### Task 1: Git worktree adapter

**Files:**
- Create: `packages/server/src/adapters/git-worktree.ts`
- Test: `packages/server/src/adapters/git-worktree.test.ts`

**Interfaces:**
- Produces: `addWorktree(opts: { repo: string; path: string; ref: string; detach?: boolean; newBranch?: string }): Promise<void>`, `removeWorktree(opts: { repo: string; path: string; force?: boolean }): Promise<void>`, `isWorktreeClean(path: string): Promise<boolean>`, `mergeBase(opts: { repo: string; base: string; head: string }): Promise<string>`, `withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T>`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/src/adapters/git-worktree.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addWorktree, removeWorktree, isWorktreeClean, mergeBase, withRepoLock } from "./git-worktree.js";

const run = promisify(execFile);
let repo: string;

before(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-git-repo-"));
  await run("git", ["init", "-b", "main", repo]);
  await run("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await run("git", ["-C", repo, "config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  await run("git", ["-C", repo, "add", "README.md"]);
  await run("git", ["-C", repo, "commit", "-m", "initial"]);
});

test("addWorktree creates a working checkout on a new branch", async () => {
  const wtPath = path.join(os.tmpdir(), `dealer-wt-${Date.now()}`);
  await addWorktree({ repo, path: wtPath, ref: "main", newBranch: "issue-1" });
  assert.ok(fs.existsSync(path.join(wtPath, "README.md")));
  await removeWorktree({ repo, path: wtPath });
});

test("addWorktree with detach checks out a detached HEAD at ref", async () => {
  const wtPath = path.join(os.tmpdir(), `dealer-wt-detached-${Date.now()}`);
  await addWorktree({ repo, path: wtPath, ref: "main", detach: true });
  const { stdout } = await run("git", ["-C", wtPath, "rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(stdout.trim(), "HEAD"); // detached HEAD reports literally "HEAD"
  await removeWorktree({ repo, path: wtPath });
});

test("isWorktreeClean reflects git status", async () => {
  const wtPath = path.join(os.tmpdir(), `dealer-wt-clean-${Date.now()}`);
  await addWorktree({ repo, path: wtPath, ref: "main", newBranch: "issue-2" });
  assert.equal(await isWorktreeClean(wtPath), true);
  fs.writeFileSync(path.join(wtPath, "new-file.txt"), "dirty\n");
  assert.equal(await isWorktreeClean(wtPath), false);
  await removeWorktree({ repo, path: wtPath, force: true });
});

test("removeWorktree without force refuses a dirty worktree", async () => {
  const wtPath = path.join(os.tmpdir(), `dealer-wt-refuse-${Date.now()}`);
  await addWorktree({ repo, path: wtPath, ref: "main", newBranch: "issue-3" });
  fs.writeFileSync(path.join(wtPath, "new-file.txt"), "dirty\n");
  await assert.rejects(() => removeWorktree({ repo, path: wtPath }));
  await removeWorktree({ repo, path: wtPath, force: true });
});

test("mergeBase returns the common ancestor SHA", async () => {
  const wtPath = path.join(os.tmpdir(), `dealer-wt-merge-${Date.now()}`);
  await addWorktree({ repo, path: wtPath, ref: "main", newBranch: "issue-4" });
  fs.writeFileSync(path.join(wtPath, "feature.txt"), "feature\n");
  await run("git", ["-C", wtPath, "add", "feature.txt"]);
  await run("git", ["-C", wtPath, "commit", "-m", "feature commit"]);
  const { stdout: mainSha } = await run("git", ["-C", repo, "rev-parse", "main"]);
  const base = await mergeBase({ repo: wtPath, base: "main", head: "issue-4" });
  assert.equal(base, mainSha.trim());
  await removeWorktree({ repo, path: wtPath, force: true });
});

test("withRepoLock serializes concurrent calls for the same repo", async () => {
  const order: number[] = [];
  const slow = (n: number) => withRepoLock(repo, async () => {
    order.push(n);
    await new Promise((r) => setTimeout(r, 10));
    order.push(-n);
  });
  await Promise.all([slow(1), slow(2), slow(3)]);
  // Each call's start (n) must be immediately followed by its own end (-n) — no interleaving.
  for (let i = 0; i < order.length; i += 2) {
    assert.equal(order[i], -order[i + 1]);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/server/src/adapters/git-worktree.test.ts`
Expected: FAIL — `Cannot find module './git-worktree.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/server/src/adapters/git-worktree.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await run("git", args, { cwd });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(`git ${args.join(" ")} failed: ${e.stderr?.trim() || e.message}`);
  }
}

export async function addWorktree(opts: {
  repo: string;
  path: string;
  ref: string;
  detach?: boolean;
  newBranch?: string;
}): Promise<void> {
  const args = ["worktree", "add"];
  if (opts.detach) args.push("--detach");
  if (opts.newBranch) args.push("-b", opts.newBranch);
  args.push(opts.path, opts.ref);
  await git(opts.repo, args);
}

export async function removeWorktree(opts: { repo: string; path: string; force?: boolean }): Promise<void> {
  const args = ["worktree", "remove"];
  if (opts.force) args.push("--force");
  args.push(opts.path);
  await git(opts.repo, args);
}

export async function isWorktreeClean(path: string): Promise<boolean> {
  const { stdout } = await git(path, ["status", "--porcelain"]);
  return stdout.trim().length === 0;
}

export async function mergeBase(opts: { repo: string; base: string; head: string }): Promise<string> {
  const { stdout } = await git(opts.repo, ["merge-base", opts.base, opts.head]);
  return stdout.trim();
}

export async function pruneWorktrees(repo: string): Promise<void> {
  await git(repo, ["worktree", "prune"]);
}

const repoLocks = new Map<string, Promise<unknown>>();

/** Serializes worktree add/remove for one repo so concurrent sessions never race .git metadata. */
export function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const prior = repoLocks.get(repo) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  repoLocks.set(
    repo,
    next.catch(() => undefined)
  );
  return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/server/src/adapters/git-worktree.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/adapters/git-worktree.ts packages/server/src/adapters/git-worktree.test.ts
git commit -m "Add git worktree adapter (NOT-57)"
```

---

### Task 2: GitHub adapter (`gh` CLI wrapper)

**Files:**
- Create: `packages/server/src/adapters/github.ts`
- Test: `packages/server/src/adapters/github.test.ts`

**Interfaces:**
- Produces: `parsePrView(json: string): PrView`, `viewPr(opts: { cwd: string }): Promise<PrView>`, `publishReview(opts: { cwd: string; prNumber: number; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; bodyFilePath: string }): Promise<PublishReviewResult>`
- `PrView = { number: number; url: string; baseRefName: string; headRefName: string; headRefOid: string; reviews: Array<{ author: string; state: string; body: string; submittedAt: string }> }`
- `PublishReviewResult = { ok: true; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" } | { ok: false; error: string }`

`viewPr` and `publishReview` shell out to `gh` and are not exercised by automated tests (no network in CI) — see the Manual verification step. `parsePrView`, which does all the actual interpretation, is pure and fully tested against fixture JSON shaped exactly like real `gh pr view --json ...` output.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/src/adapters/github.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrView } from "./github.js";

const FIXTURE = JSON.stringify({
  number: 142,
  url: "https://github.com/org/repo/pull/142",
  baseRefName: "main",
  headRefName: "issue-1",
  headRefOid: "a84f20cdeadbeef0000000000000000000000",
  reviews: [
    {
      author: { login: "reviewer-bot" },
      state: "CHANGES_REQUESTED",
      body: "Found 2 blocking issues",
      submittedAt: "2026-09-10T12:00:00Z",
    },
  ],
});

test("parsePrView extracts identity, head SHA, and normalized reviews", () => {
  const view = parsePrView(FIXTURE);
  assert.equal(view.number, 142);
  assert.equal(view.headRefOid, "a84f20cdeadbeef0000000000000000000000");
  assert.equal(view.baseRefName, "main");
  assert.equal(view.reviews.length, 1);
  assert.equal(view.reviews[0].author, "reviewer-bot");
  assert.equal(view.reviews[0].state, "CHANGES_REQUESTED");
});

test("parsePrView handles a PR with no reviews yet", () => {
  const view = parsePrView(JSON.stringify({ number: 1, url: "u", baseRefName: "main", headRefName: "b", headRefOid: "sha", reviews: [] }));
  assert.deepStrictEqual(view.reviews, []);
});

test("parsePrView throws on malformed JSON rather than silently returning a partial view", () => {
  assert.throws(() => parsePrView("not json"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/server/src/adapters/github.test.ts`
Expected: FAIL — `Cannot find module './github.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/server/src/adapters/github.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface PrView {
  number: number;
  url: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  reviews: Array<{ author: string; state: string; body: string; submittedAt: string }>;
}

interface RawPrView {
  number: number;
  url: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  reviews: Array<{ author: { login: string }; state: string; body: string; submittedAt: string }>;
}

export function parsePrView(json: string): PrView {
  const raw = JSON.parse(json) as RawPrView;
  return {
    number: raw.number,
    url: raw.url,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    headRefOid: raw.headRefOid,
    reviews: raw.reviews.map((r) => ({
      author: r.author.login,
      state: r.state,
      body: r.body,
      submittedAt: r.submittedAt,
    })),
  };
}

const PR_VIEW_FIELDS = "number,url,baseRefName,headRefName,headRefOid,reviews";

export async function viewPr(opts: { cwd: string }): Promise<PrView> {
  const { stdout } = await run("gh", ["pr", "view", "--json", PR_VIEW_FIELDS], { cwd: opts.cwd });
  return parsePrView(stdout);
}

export type PublishReviewResult =
  | { ok: true; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" }
  | { ok: false; error: string };

const EVENT_FLAG: Record<"APPROVE" | "REQUEST_CHANGES" | "COMMENT", string> = {
  APPROVE: "--approve",
  REQUEST_CHANGES: "--request-changes",
  COMMENT: "--comment",
};

/**
 * Publishes a PR review via `gh pr review --body-file` (never shell-interpolates the
 * body). If GitHub rejects APPROVE/REQUEST_CHANGES because the configured identity
 * authored the PR, retries once as a comment review — same content, different event type.
 */
export async function publishReview(opts: {
  cwd: string;
  prNumber: number;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  bodyFilePath: string;
}): Promise<PublishReviewResult> {
  const attempt = async (event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT") => {
    await run(
      "gh",
      ["pr", "review", String(opts.prNumber), EVENT_FLAG[event], "--body-file", opts.bodyFilePath],
      { cwd: opts.cwd }
    );
    return event;
  };

  try {
    const event = await attempt(opts.event);
    return { ok: true, event };
  } catch (err) {
    const message = (err as { stderr?: string; message: string }).stderr ?? (err as Error).message;
    if (opts.event !== "COMMENT" && /own pull request/i.test(message)) {
      try {
        const event = await attempt("COMMENT");
        return { ok: true, event };
      } catch (err2) {
        return { ok: false, error: (err2 as Error).message };
      }
    }
    return { ok: false, error: message };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/server/src/adapters/github.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Manual verification (not automated — no network in CI)**

In a real repo with an open draft PR and `gh auth status` logged in:
```bash
cd <repo-with-open-pr> && node -e '
import("./packages/server/dist/adapters/github.js").then(async (m) => {
  console.log(await m.viewPr({ cwd: process.cwd() }));
});
'
```
Confirm the printed object has `number`/`headRefOid`/`reviews` matching what `gh pr view` shows directly. Skip `publishReview` manual verification unless you have a disposable PR — it's a real write.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/adapters/github.ts packages/server/src/adapters/github.test.ts
git commit -m "Add GitHub adapter (gh CLI wrapper) with tested PR-view parser (NOT-57)"
```

---

### Task 3: Reviewer result schema + prompts

**Files:**
- Create: `packages/server/src/coordinator/reviewer-result.ts`
- Create: `packages/server/src/coordinator/prompts.ts`
- Test: `packages/server/src/coordinator/reviewer-result.test.ts`
- Test: `packages/server/src/coordinator/prompts.test.ts`

**Interfaces:**
- Produces: `ReviewerVerdict`, `ReviewerFinding`, `ReviewerResult` (Zod), `parseReviewerResult(text: string): ReviewerResult | null`; `buildDeveloperPrompt(input: DeveloperPromptInput): string`, `buildReviewerPrompt(input: ReviewerPromptInput): string`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/server/src/coordinator/reviewer-result.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReviewerResult } from "./reviewer-result.js";

const VALID_BLOCK = `
Reviewed the diff against the task snapshot.

\`\`\`json
{
  "verdict": "changes_requested",
  "baseSha": "abc123",
  "headSha": "def456",
  "acceptanceCriteriaAssessment": "Partially met — missing null check",
  "evidenceAssessment": "42 tests pass, Lens passed",
  "findings": [
    {"fingerprint": "auth-null-check", "severity": "blocking", "title": "Missing null check", "rationale": "user can be undefined", "file": "src/auth.ts", "line": 42}
  ],
  "risks": ["No test covers the logout race condition"]
}
\`\`\`
`;

test("parseReviewerResult extracts a valid JSON fence", () => {
  const result = parseReviewerResult(VALID_BLOCK);
  assert.equal(result?.verdict, "changes_requested");
  assert.equal(result?.findings.length, 1);
  assert.equal(result?.findings[0].fingerprint, "auth-null-check");
});

test("parseReviewerResult returns null for prose with no JSON fence", () => {
  assert.equal(parseReviewerResult("Looks good to me, approved."), null);
});

test("parseReviewerResult returns null when the fence doesn't match the schema", () => {
  assert.equal(parseReviewerResult("```json\n{\"verdict\": \"maybe\"}\n```"), null);
});
```

```typescript
// packages/server/src/coordinator/prompts.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeveloperPrompt, buildReviewerPrompt } from "./prompts.js";

test("buildDeveloperPrompt includes the task snapshot and round number", () => {
  const prompt = buildDeveloperPrompt({
    taskSnapshot: { title: "Fix login bug", description: "Users get logged out", acceptanceCriteria: "Login persists across refresh", repo: "/repo", baseBranch: "main" },
    round: 1,
  });
  assert.ok(prompt.includes("Fix login bug"));
  assert.ok(prompt.includes("Login persists across refresh"));
  assert.ok(prompt.includes("implementation conclusion"));
});

test("buildDeveloperPrompt includes prior findings on a repair round", () => {
  const prompt = buildDeveloperPrompt({
    taskSnapshot: { title: "T", description: "D", acceptanceCriteria: "A", repo: "/repo", baseBranch: "main" },
    round: 2,
    findings: [{ id: "f1", issueId: "i1", fingerprint: "fp1", severity: "blocking", title: "Missing null check", rationale: "user can be undefined", evidenceRef: null, file: "src/auth.ts", line: 42, status: "open", firstRound: 1, lastRound: 1 }],
  });
  assert.ok(prompt.includes("Missing null check"));
  assert.ok(prompt.includes("src/auth.ts"));
});

test("buildReviewerPrompt includes base/head SHA and the JSON-fence contract", () => {
  const prompt = buildReviewerPrompt({
    taskSnapshot: { title: "T", description: "D", acceptanceCriteria: "A", repo: "/repo", baseBranch: "main" },
    baseSha: "abc123",
    headSha: "def456",
  });
  assert.ok(prompt.includes("abc123"));
  assert.ok(prompt.includes("def456"));
  assert.ok(prompt.includes("```json"));
  assert.ok(prompt.includes("verdict"));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test packages/server/src/coordinator/reviewer-result.test.ts packages/server/src/coordinator/prompts.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the implementations**

```typescript
// packages/server/src/coordinator/reviewer-result.ts
import { z } from "zod";

export const ReviewerVerdict = z.enum(["approved", "changes_requested", "escalated"]);
export type ReviewerVerdict = z.infer<typeof ReviewerVerdict>;

export const ReviewerFinding = z.object({
  fingerprint: z.string(),
  severity: z.enum(["blocking", "non_blocking"]),
  title: z.string(),
  rationale: z.string(),
  file: z.string().optional(),
  line: z.number().int().optional(),
});
export type ReviewerFinding = z.infer<typeof ReviewerFinding>;

export const ReviewerResult = z.object({
  verdict: ReviewerVerdict,
  baseSha: z.string(),
  headSha: z.string(),
  acceptanceCriteriaAssessment: z.string(),
  evidenceAssessment: z.string(),
  findings: z.array(ReviewerFinding),
  risks: z.array(z.string()),
  /** Present only when verdict is "escalated" and the reviewer identifies a missing product call. */
  productScopeQuestion: z.string().optional(),
});
export type ReviewerResult = z.infer<typeof ReviewerResult>;

/** Mirrors the plan-triage/reflect JSON-fence parsing pattern already used elsewhere. */
export function parseReviewerResult(text: string): ReviewerResult | null {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidates = [fenceMatch?.[1] ?? trimmed, trimmed];
  for (const candidate of candidates) {
    try {
      const parsed = ReviewerResult.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // try next candidate
    }
  }
  return null;
}
```

```typescript
// packages/server/src/coordinator/prompts.ts
import type { Finding } from "@agent-dealer/shared";

export interface TaskSnapshot {
  title: string;
  description: string;
  acceptanceCriteria: string;
  repo: string;
  baseBranch: string;
}

export interface DeveloperPromptInput {
  taskSnapshot: TaskSnapshot;
  round: number;
  findings?: Finding[];
}

export function buildDeveloperPrompt(input: DeveloperPromptInput): string {
  const parts = [
    input.round === 1
      ? `Implement this issue on a fresh branch off ${input.taskSnapshot.baseBranch}.`
      : `This is repair round ${input.round}. Address every blocking finding below, then push and update the draft PR.`,
    ``,
    `## Task`,
    input.taskSnapshot.title,
    input.taskSnapshot.description,
    ``,
    `## Acceptance criteria`,
    input.taskSnapshot.acceptanceCriteria,
    ``,
  ];

  if (input.findings?.length) {
    parts.push(`## Findings to address`);
    for (const f of input.findings) {
      const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
      parts.push(`- [${f.severity}] ${f.title}${loc}: ${f.rationale}`);
    }
    parts.push(``);
  }

  parts.push(
    `## Required`,
    `Run tests and Lens checks. Push your branch with \`git\` and open or update the draft PR with \`gh pr create\`/\`gh pr edit\`.`,
    `End your reply with a short **implementation conclusion**: what changed, why, any deviations from the acceptance criteria, and known follow-ups. This is distinct from the PR description and is required every round.`
  );

  return parts.join("\n");
}

export interface ReviewerPromptInput {
  taskSnapshot: TaskSnapshot;
  baseSha: string;
  headSha: string;
  implementationConclusion?: string;
  priorFindings?: Finding[];
}

export function buildReviewerPrompt(input: ReviewerPromptInput): string {
  const parts = [
    `Review this pull request. You have read-only repository access — do not edit files, push, or change workflow state.`,
    ``,
    `## Task snapshot`,
    input.taskSnapshot.title,
    input.taskSnapshot.description,
    ``,
    `## Acceptance criteria`,
    input.taskSnapshot.acceptanceCriteria,
    ``,
    `## SHAs to review`,
    `Base: ${input.baseSha}`,
    `Head: ${input.headSha}`,
    ``,
  ];

  if (input.implementationConclusion) {
    parts.push(`## Developer's implementation conclusion`, input.implementationConclusion, ``);
  }

  if (input.priorFindings?.length) {
    parts.push(`## Prior finding history`);
    for (const f of input.priorFindings) {
      parts.push(`- [${f.status}] ${f.title} (first seen round ${f.firstRound})`);
    }
    parts.push(``);
  }

  parts.push(
    `Submit your review with \`gh pr review\`, ending the review body with exactly one fenced ` +
      "```json" +
      ` block:`,
    `{"verdict":"approved"|"changes_requested"|"escalated","baseSha":"...","headSha":"...","acceptanceCriteriaAssessment":"...","evidenceAssessment":"...","findings":[{"fingerprint":"...","severity":"blocking"|"non_blocking","title":"...","rationale":"...","file":"...","line":0}],"risks":["..."],"productScopeQuestion":"..."}`,
    `Rules:`,
    `- "escalated" means you cannot form approved/changes_requested — set productScopeQuestion if a missing product decision is the reason.`,
    `- Every blocking finding needs a stable fingerprint so it can be tracked across rounds — reuse the same fingerprint if you're confirming a prior finding is still open.`
  );

  return parts.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test packages/server/src/coordinator/reviewer-result.test.ts packages/server/src/coordinator/prompts.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full server test suite, then commit**

```bash
npx tsx --test $(find packages/server -name '*.test.ts')
git add packages/server/src/coordinator/reviewer-result.ts packages/server/src/coordinator/reviewer-result.test.ts \
        packages/server/src/coordinator/prompts.ts packages/server/src/coordinator/prompts.test.ts
git commit -m "Add reviewer result schema/parser and developer/reviewer prompts (NOT-57)"
```

---

### Task 4: Verification & outcome routing (the state machine's core)

**Files:**
- Create: `packages/server/src/coordinator/routing.ts`
- Test: `packages/server/src/coordinator/routing.test.ts`

This is the single most important file in the coordinator — every case in the spec's Testing section maps to a test here. Get this exactly right; `session-lifecycle.ts` (Task 6) just calls into it.

**Interfaces:**
- Produces:
  - `type DeveloperOutcome = { kind: "clean_handoff"; headSha: string; baseSha: string; prNumber: number; prUrl: string } | { kind: "no_pr" } | { kind: "dirty_worktree" } | { kind: "session_failed" }`
  - `type ReviewerOutcome = { kind: "verdict"; result: ReviewerResult } | { kind: "stale"; currentHeadSha: string } | { kind: "session_failed" } | { kind: "publish_failed" }`
  - `type RoundLimits = { currentRound: number; maxReviewRounds: number }`
  - `type DeveloperRouteResult = { next: "spawn_reviewer" } | { next: "retry_developer" } | { next: "human_action"; actionType: "attempts_exhausted" | "policy_escalation"; reason: string }`
  - `type ReviewerRouteResult = { next: "final_review" } | { next: "retry_developer_with_findings" } | { next: "retry_reviewer_same_head" } | { next: "human_action"; actionType: "attempts_exhausted" | "policy_escalation" | "product_scope_decision"; reason: string }`
  - `routeDeveloperOutcome(outcome: DeveloperOutcome, limits: RoundLimits): DeveloperRouteResult`
  - `routeReviewerOutcome(outcome: ReviewerOutcome, limits: RoundLimits): ReviewerRouteResult`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/src/coordinator/routing.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeDeveloperOutcome, routeReviewerOutcome, type DeveloperOutcome, type ReviewerOutcome } from "./routing.js";

const LIMITS_ROUNDS_LEFT = { currentRound: 1, maxReviewRounds: 3 };
const LIMITS_AT_LIMIT = { currentRound: 3, maxReviewRounds: 3 };

// --- Developer outcomes ---

test("clean handoff routes to spawn_reviewer", () => {
  const outcome: DeveloperOutcome = { kind: "clean_handoff", headSha: "h", baseSha: "b", prNumber: 1, prUrl: "u" };
  assert.deepStrictEqual(routeDeveloperOutcome(outcome, LIMITS_ROUNDS_LEFT), { next: "spawn_reviewer" });
});

test("no PR with rounds remaining retries the developer without consuming a reviewer verdict", () => {
  const outcome: DeveloperOutcome = { kind: "no_pr" };
  assert.deepStrictEqual(routeDeveloperOutcome(outcome, LIMITS_ROUNDS_LEFT), { next: "retry_developer" });
});

test("no PR at the round limit exhausts attempts", () => {
  const outcome: DeveloperOutcome = { kind: "no_pr" };
  const result = routeDeveloperOutcome(outcome, LIMITS_AT_LIMIT);
  assert.equal(result.next, "human_action");
  assert.equal((result as { actionType: string }).actionType, "attempts_exhausted");
});

test("session_failed with rounds remaining also just retries (same bucket as no_pr)", () => {
  const outcome: DeveloperOutcome = { kind: "session_failed" };
  assert.deepStrictEqual(routeDeveloperOutcome(outcome, LIMITS_ROUNDS_LEFT), { next: "retry_developer" });
});

test("dirty worktree always escalates, even with rounds remaining — never spends a round", () => {
  const outcome: DeveloperOutcome = { kind: "dirty_worktree" };
  const result = routeDeveloperOutcome(outcome, LIMITS_ROUNDS_LEFT);
  assert.equal(result.next, "human_action");
  assert.equal((result as { actionType: string }).actionType, "policy_escalation");
});

// --- Reviewer outcomes ---

test("approved verdict routes to final_review regardless of round", () => {
  const outcome: ReviewerOutcome = {
    kind: "verdict",
    result: { verdict: "approved", baseSha: "b", headSha: "h", acceptanceCriteriaAssessment: "met", evidenceAssessment: "ok", findings: [], risks: [] },
  };
  assert.deepStrictEqual(routeReviewerOutcome(outcome, LIMITS_ROUNDS_LEFT), { next: "final_review" });
});

test("changes_requested with rounds remaining retries the developer with findings", () => {
  const outcome: ReviewerOutcome = {
    kind: "verdict",
    result: { verdict: "changes_requested", baseSha: "b", headSha: "h", acceptanceCriteriaAssessment: "partial", evidenceAssessment: "ok", findings: [{ fingerprint: "f1", severity: "blocking", title: "T", rationale: "R" }], risks: [] },
  };
  assert.deepStrictEqual(routeReviewerOutcome(outcome, LIMITS_ROUNDS_LEFT), { next: "retry_developer_with_findings" });
});

test("changes_requested at the round limit exhausts attempts", () => {
  const outcome: ReviewerOutcome = {
    kind: "verdict",
    result: { verdict: "changes_requested", baseSha: "b", headSha: "h", acceptanceCriteriaAssessment: "partial", evidenceAssessment: "ok", findings: [], risks: [] },
  };
  const result = routeReviewerOutcome(outcome, LIMITS_AT_LIMIT);
  assert.equal(result.next, "human_action");
  assert.equal((result as { actionType: string }).actionType, "attempts_exhausted");
});

test("escalated with a product scope question routes to product_scope_decision", () => {
  const outcome: ReviewerOutcome = {
    kind: "verdict",
    result: { verdict: "escalated", baseSha: "b", headSha: "h", acceptanceCriteriaAssessment: "unclear", evidenceAssessment: "ok", findings: [], risks: [], productScopeQuestion: "Should deleted users retain their sessions?" },
  };
  const result = routeReviewerOutcome(outcome, LIMITS_ROUNDS_LEFT);
  assert.equal((result as { actionType: string }).actionType, "product_scope_decision");
});

test("escalated without a product scope question routes to policy_escalation", () => {
  const outcome: ReviewerOutcome = {
    kind: "verdict",
    result: { verdict: "escalated", baseSha: "b", headSha: "h", acceptanceCriteriaAssessment: "unclear", evidenceAssessment: "ok", findings: [], risks: [] },
  };
  const result = routeReviewerOutcome(outcome, LIMITS_ROUNDS_LEFT);
  assert.equal((result as { actionType: string }).actionType, "policy_escalation");
});

test("stale review retries the reviewer at the same head without consuming a round", () => {
  const outcome: ReviewerOutcome = { kind: "stale", currentHeadSha: "new-head" };
  assert.deepStrictEqual(routeReviewerOutcome(outcome, LIMITS_ROUNDS_LEFT), { next: "retry_reviewer_same_head" });
});

test("reviewer session_failed escalates rather than silently retrying", () => {
  const outcome: ReviewerOutcome = { kind: "session_failed" };
  const result = routeReviewerOutcome(outcome, LIMITS_ROUNDS_LEFT);
  assert.equal(result.next, "human_action");
  assert.equal((result as { actionType: string }).actionType, "policy_escalation");
});

test("review publish_failed escalates rather than being confused with a code finding", () => {
  const outcome: ReviewerOutcome = { kind: "publish_failed" };
  const result = routeReviewerOutcome(outcome, LIMITS_ROUNDS_LEFT);
  assert.equal(result.next, "human_action");
  assert.equal((result as { actionType: string }).actionType, "policy_escalation");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/server/src/coordinator/routing.test.ts`
Expected: FAIL — `Cannot find module './routing.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/server/src/coordinator/routing.ts
import type { ReviewerResult } from "./reviewer-result.js";

export type DeveloperOutcome =
  | { kind: "clean_handoff"; headSha: string; baseSha: string; prNumber: number; prUrl: string }
  | { kind: "no_pr" }
  | { kind: "dirty_worktree" }
  | { kind: "session_failed" };

export type ReviewerOutcome =
  | { kind: "verdict"; result: ReviewerResult }
  | { kind: "stale"; currentHeadSha: string }
  | { kind: "session_failed" }
  | { kind: "publish_failed" };

export interface RoundLimits {
  currentRound: number;
  maxReviewRounds: number;
}

function roundsRemain(limits: RoundLimits): boolean {
  return limits.currentRound < limits.maxReviewRounds;
}

export type DeveloperRouteResult =
  | { next: "spawn_reviewer" }
  | { next: "retry_developer" }
  | { next: "human_action"; actionType: "attempts_exhausted" | "policy_escalation"; reason: string };

export function routeDeveloperOutcome(outcome: DeveloperOutcome, limits: RoundLimits): DeveloperRouteResult {
  switch (outcome.kind) {
    case "clean_handoff":
      return { next: "spawn_reviewer" };
    case "dirty_worktree":
      // Never spends a round — an unclean handoff is preserved for inspection, not retried blindly.
      return { next: "human_action", actionType: "policy_escalation", reason: "Developer worktree has uncommitted or unpushed changes after the session ended." };
    case "no_pr":
    case "session_failed":
      return roundsRemain(limits)
        ? { next: "retry_developer" }
        : { next: "human_action", actionType: "attempts_exhausted", reason: "Developer session failed or produced no PR, and the review-round limit is reached." };
  }
}

export type ReviewerRouteResult =
  | { next: "final_review" }
  | { next: "retry_developer_with_findings" }
  | { next: "retry_reviewer_same_head" }
  | { next: "human_action"; actionType: "attempts_exhausted" | "policy_escalation" | "product_scope_decision"; reason: string };

export function routeReviewerOutcome(outcome: ReviewerOutcome, limits: RoundLimits): ReviewerRouteResult {
  switch (outcome.kind) {
    case "stale":
      return { next: "retry_reviewer_same_head" };
    case "session_failed":
      return { next: "human_action", actionType: "policy_escalation", reason: "Reviewer session failed, timed out, or its worktree checkout failed." };
    case "publish_failed":
      return { next: "human_action", actionType: "policy_escalation", reason: "Review publication to GitHub failed — infrastructure issue, not a code finding." };
    case "verdict":
      return routeVerdict(outcome.result, limits);
  }
}

function routeVerdict(result: ReviewerResult, limits: RoundLimits): ReviewerRouteResult {
  switch (result.verdict) {
    case "approved":
      return { next: "final_review" };
    case "changes_requested":
      return roundsRemain(limits)
        ? { next: "retry_developer_with_findings" }
        : { next: "human_action", actionType: "attempts_exhausted", reason: "Reviewer requested changes and the review-round limit is reached." };
    case "escalated":
      return result.productScopeQuestion
        ? { next: "human_action", actionType: "product_scope_decision", reason: result.productScopeQuestion }
        : { next: "human_action", actionType: "policy_escalation", reason: "Reviewer escalated without a resolvable code change." };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/server/src/coordinator/routing.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Run the full server test suite, then commit**

```bash
npx tsx --test $(find packages/server -name '*.test.ts')
git add packages/server/src/coordinator/routing.ts packages/server/src/coordinator/routing.test.ts
git commit -m "Add coordinator outcome-routing state machine (NOT-57)"
```

---

### Task 5: Per-runtime, per-role spawn wrappers

**Files:**
- Create: `packages/server/src/coordinator/args.ts`
- Create: `packages/server/src/coordinator/spawn.ts`
- Test: `packages/server/src/coordinator/args.test.ts`

**Interfaces:**
- Consumes: `resolveClaudeBin`/`resolveCursorBin`/`resolveCodexBin` from `../cli-env.js`; `spawnCli`/`logPathFor`/`timeoutMsForMode` from `../runners/spawn-cli.js`; `WorkerSession` from `@agent-dealer/shared`.
- Produces: `buildDeveloperArgs(runtime: Runtime, prompt: string, model?: string): string[]`, `buildReviewerArgs(runtime: Runtime, prompt: string, model?: string): string[]`, `spawnDeveloperSession(session: WorkerSession, prompt: string): Promise<RunnerResult>`, `spawnReviewerSession(session: WorkerSession, prompt: string): Promise<RunnerResult>`

Only `args.ts` is unit tested (pure arg-building, no subprocess). `spawn.ts` dispatches to the real binaries and `spawnCli` — same "thin, untested wrapper around a tested pure function" pattern as `runClaude`/`runCursor`/`runCodex` themselves, which also have no direct spawn test in this codebase.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/src/coordinator/args.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeveloperArgs, buildReviewerArgs } from "./args.js";

test("buildDeveloperArgs for claude_code allows Bash and Write/Edit", () => {
  const args = buildDeveloperArgs("claude_code", "do the task");
  assert.ok(args.includes("-p"));
  assert.ok(args.includes("do the task"));
  const toolsIdx = args.indexOf("--allowedTools");
  assert.ok(toolsIdx >= 0);
  assert.ok(args[toolsIdx + 1].includes("Bash"));
  assert.ok(args[toolsIdx + 1].includes("Write"));
});

test("buildReviewerArgs for claude_code excludes Write/Edit and denies the send tool", () => {
  const args = buildReviewerArgs("claude_code", "review the diff");
  const toolsIdx = args.indexOf("--allowedTools");
  assert.ok(!args[toolsIdx + 1].includes("Write"));
  assert.ok(!args[toolsIdx + 1].includes("Edit"));
  assert.ok(args.includes("--disallowedTools"));
});

test("buildDeveloperArgs passes model through when given", () => {
  const args = buildDeveloperArgs("claude_code", "prompt", "claude-opus-5");
  assert.ok(args.includes("--model"));
  assert.ok(args.includes("claude-opus-5"));
});

test("buildDeveloperArgs for codex_local uses exec subcommand shape", () => {
  const args = buildDeveloperArgs("codex_local", "do the task");
  assert.equal(args[0], "exec");
  assert.ok(args.includes("workspace-write"));
});

test("buildReviewerArgs for codex_local uses read-only sandbox", () => {
  const args = buildReviewerArgs("codex_local", "review the diff");
  assert.ok(args.includes("read-only"));
});

test("buildDeveloperArgs for cursor_local requests stream-json output", () => {
  const args = buildDeveloperArgs("cursor_local", "do the task");
  assert.ok(args.includes("--output-format"));
  assert.ok(args.includes("stream-json"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/server/src/coordinator/args.test.ts`
Expected: FAIL — `Cannot find module './args.js'`

- [ ] **Step 3: Write the implementations**

```typescript
// packages/server/src/coordinator/args.ts
import type { Runtime } from "@agent-dealer/shared";

const DECK_READ_TOOLS =
  "mcp__agent-deck__get_playbook,mcp__agent-deck__get_bound_deck,mcp__agent-deck__bind_workspace,mcp__agent-deck__list_service_tools";
const DENY_SEND_TOOL = "mcp__agent-deck__call_service_tool";

const DEVELOPER_TOOLS = `Read,Write,Edit,Glob,Grep,Bash,Skill,${DECK_READ_TOOLS}`;
const REVIEWER_TOOLS = `Read,Glob,Grep,Bash,Skill,${DECK_READ_TOOLS}`;

export function buildDeveloperArgs(runtime: Runtime, prompt: string, model?: string): string[] {
  if (runtime === "codex_local") {
    return ["exec", "--json", "-s", "workspace-write", ...(model ? ["-m", model] : []), prompt];
  }
  if (runtime === "cursor_local") {
    return [
      "-p",
      "--trust",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      ...(model ? ["--model", model] : []),
      prompt,
    ];
  }
  return [
    ...(model ? ["--model", model] : []),
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--allowedTools",
    DEVELOPER_TOOLS,
  ];
}

export function buildReviewerArgs(runtime: Runtime, prompt: string, model?: string): string[] {
  if (runtime === "codex_local") {
    return ["exec", "--json", "-s", "read-only", ...(model ? ["-m", model] : []), prompt];
  }
  if (runtime === "cursor_local") {
    return [
      "-p",
      "--trust",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--mode",
      "ask",
      ...(model ? ["--model", model] : []),
      prompt,
    ];
  }
  return [
    ...(model ? ["--model", model] : []),
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--allowedTools",
    REVIEWER_TOOLS,
    "--disallowedTools",
    DENY_SEND_TOOL,
  ];
}
```

```typescript
// packages/server/src/coordinator/spawn.ts
import type { WorkerSession } from "@agent-dealer/shared";
import { resolveClaudeBin, resolveCodexBin, resolveCursorBin } from "../cli-env.js";
import { spawnCli, type RunnerResult } from "../runners/spawn-cli.js";
import { buildDeveloperArgs, buildReviewerArgs } from "./args.js";

const SESSION_TIMEOUT_MS = Number(process.env.COORDINATOR_SESSION_TIMEOUT_MS ?? 60 * 60_000);

function binFor(runtime: WorkerSession["runtime"]): string {
  if (runtime === "codex_local") return resolveCodexBin();
  if (runtime === "cursor_local") return resolveCursorBin();
  return resolveClaudeBin();
}

async function spawn(session: WorkerSession, args: string[]): Promise<RunnerResult> {
  if (!session.worktreePath) throw new Error(`Session ${session.id} has no worktreePath to spawn into`);
  const logPath = `${session.worktreePath}.log`;
  const { exitCode, transcript, timedOut } = await spawnCli(session.id, binFor(session.runtime), args, session.worktreePath, {
    logPath,
    timeoutMs: SESSION_TIMEOUT_MS,
  });
  return { exitCode, transcript, logPath, timedOut };
}

export function spawnDeveloperSession(session: WorkerSession, prompt: string): Promise<RunnerResult> {
  return spawn(session, buildDeveloperArgs(session.runtime ?? "claude_code", prompt, session.model ?? undefined));
}

export function spawnReviewerSession(session: WorkerSession, prompt: string): Promise<RunnerResult> {
  return spawn(session, buildReviewerArgs(session.runtime ?? "claude_code", prompt, session.model ?? undefined));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/server/src/coordinator/args.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Manual verification (not automated — real CLI spawn)**

Once a real issue can be started end-to-end (after Task 6), watch one developer session run against a scratch repo and confirm the process actually launches with the expected flags (`ps aux | grep claude` while it runs, or check the log file at `<worktreePath>.log`). Not blocking for this task in isolation — defer to Task 6/9's manual verification.

- [ ] **Step 6: Run the full server test suite, then commit**

```bash
npx tsx --test $(find packages/server -name '*.test.ts')
git add packages/server/src/coordinator/args.ts packages/server/src/coordinator/args.test.ts packages/server/src/coordinator/spawn.ts
git commit -m "Add per-runtime developer/reviewer spawn wrappers (NOT-57)"
```

---

### Task 6: Coordinator orchestrator (session lifecycle)

**Files:**
- Create: `packages/server/src/coordinator/session-lifecycle.ts`
- Test: `packages/server/src/coordinator/session-lifecycle.test.ts`

This is the largest task — it wires Plan 1's repositories together with Tasks 1–5's adapters/routing/prompts/spawn into the actual 7-step lifecycle. It takes its `git`/`github`/spawn dependencies as parameters so the whole state machine is testable with fakes, per the spec.

**Interfaces:**
- Consumes: `createIssue`/`getIssue`/`transitionIssue`/`incrementIssueRound` (`../repository/issues.js`); `createWorkerSession`/`claimQueuedSession`/`completeSession` (`../repository/worker-sessions.js`); `startWorkflowInstance`/`appendWorkflowEvent` (`../repository/workflow-events.js`); `createHumanAction` (`../repository/human-actions.js`); `reconcileFinding` (`../repository/findings.js`); `routeDeveloperOutcome`/`routeReviewerOutcome` (`./routing.js`); `buildDeveloperPrompt`/`buildReviewerPrompt` (`./prompts.js`); `parseReviewerResult` (`./reviewer-result.js`)
- Produces:
  - `interface CoordinatorDeps { worktree: { addWorktree; removeWorktree; isWorktreeClean; mergeBase }; github: { viewPr; publishReview }; spawnDeveloper: typeof spawnDeveloperSession; spawnReviewer: typeof spawnReviewerSession }`
  - `defaultCoordinatorDeps: CoordinatorDeps` (the real adapters/spawn wrappers)
  - `async function startIssueWorkflow(issueId: string, deps?: CoordinatorDeps): Promise<void>`
  - `async function advanceIssue(issueId: string, deps?: CoordinatorDeps): Promise<void>` — runs one queued session to completion and routes the outcome; the dispatcher (Task 7) calls this per claimed session.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/src/coordinator/session-lifecycle.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-lifecycle-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { listWorkerSessionsForIssue } = await import("../repository/worker-sessions.js");
const { listOpenHumanActions } = await import("../repository/human-actions.js");
const { listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
const { startIssueWorkflow, advanceIssue } = await import("./session-lifecycle.js");
const { ReviewerResult } = await import("./reviewer-result.js");

before(() => {
  migrate();
});

function seedIssue(title: string) {
  return createIssue({
    title,
    description: "test issue",
    acceptanceCriteria: "works",
    repo: "/tmp/fake-repo",
    baseBranch: "main",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    maxReviewRounds: 3,
    source: "manual",
  });
}

/** Fake deps: no real git/gh/spawn — deterministic canned responses per test. */
function fakeDeps(overrides: Partial<{
  addWorktree: () => Promise<void>;
  isWorktreeClean: () => Promise<boolean>;
  mergeBase: () => Promise<string>;
  viewPr: () => Promise<{ number: number; url: string; headRefOid: string; baseRefName: string; headRefName: string; reviews: Array<{ author: string; state: string; body: string; submittedAt: string }> }>;
  publishReview: () => Promise<{ ok: true; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" } | { ok: false; error: string }>;
  spawnDeveloper: () => Promise<{ exitCode: number; transcript: string; logPath: string; timedOut?: boolean }>;
  spawnReviewer: () => Promise<{ exitCode: number; transcript: string; logPath: string; timedOut?: boolean }>;
}> = {}) {
  return {
    worktree: {
      addWorktree: overrides.addWorktree ?? (async () => {}),
      removeWorktree: async () => {},
      isWorktreeClean: overrides.isWorktreeClean ?? (async () => true),
      mergeBase: overrides.mergeBase ?? (async () => "base-sha-1"),
    },
    github: {
      viewPr:
        overrides.viewPr ??
        (async () => ({ number: 1, url: "https://github.com/x/y/pull/1", headRefOid: "head-sha-1", baseRefName: "main", headRefName: "issue-branch", reviews: [] })),
      publishReview: overrides.publishReview ?? (async () => ({ ok: true as const, event: "APPROVE" as const })),
    },
    spawnDeveloper: overrides.spawnDeveloper ?? (async () => ({ exitCode: 0, transcript: "done", logPath: "/tmp/log" })),
    spawnReviewer: overrides.spawnReviewer ?? (async () => ({ exitCode: 0, transcript: "reviewed", logPath: "/tmp/log" })),
  };
}

test("starting a workflow creates one instance and one queued developer session for round 1", async () => {
  const issue = seedIssue("Start workflow");
  await startIssueWorkflow(issue.id, fakeDeps());
  const sessions = listWorkerSessionsForIssue(issue.id);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].role, "developer");
  assert.equal(sessions[0].round, 1);
  assert.equal(getIssue(issue.id)?.status, "developing");
});

test("clean developer handoff advances to a queued reviewer session", async () => {
  const issue = seedIssue("Clean handoff");
  await startIssueWorkflow(issue.id, fakeDeps());
  await advanceIssue(issue.id, fakeDeps());
  const sessions = listWorkerSessionsForIssue(issue.id);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1].role, "reviewer");
  assert.equal(sessions[1].inputSha, "head-sha-1");
  assert.equal(getIssue(issue.id)?.status, "reviewing");
  assert.equal(getIssue(issue.id)?.headSha, "head-sha-1");
});

test("approved review creates a final_review human action", async () => {
  const issue = seedIssue("Approved review");
  const approvedResult: unknown = { verdict: "approved", baseSha: "base-sha-1", headSha: "head-sha-1", acceptanceCriteriaAssessment: "met", evidenceAssessment: "ok", findings: [], risks: [] };
  await startIssueWorkflow(issue.id, fakeDeps());
  await advanceIssue(issue.id, fakeDeps()); // developer -> reviewer queued
  await advanceIssue(
    issue.id,
    fakeDeps({
      spawnReviewer: async () => ({ exitCode: 0, transcript: "```json\n" + JSON.stringify(approvedResult) + "\n```", logPath: "/tmp/log" }),
    })
  ); // reviewer runs -> approved
  assert.equal(getIssue(issue.id)?.status, "final_review");
  const actions = listOpenHumanActions();
  assert.ok(actions.some((a) => a.issueId === issue.id && a.actionType === "final_review"));
});

test("changes_requested with rounds remaining queues a round-2 developer session with findings context", async () => {
  const issue = seedIssue("Changes requested");
  const crResult: unknown = {
    verdict: "changes_requested",
    baseSha: "base-sha-1",
    headSha: "head-sha-1",
    acceptanceCriteriaAssessment: "partial",
    evidenceAssessment: "ok",
    findings: [{ fingerprint: "fp1", severity: "blocking", title: "Missing check", rationale: "r" }],
    risks: [],
  };
  await startIssueWorkflow(issue.id, fakeDeps());
  await advanceIssue(issue.id, fakeDeps());
  await advanceIssue(
    issue.id,
    fakeDeps({ spawnReviewer: async () => ({ exitCode: 0, transcript: "```json\n" + JSON.stringify(crResult) + "\n```", logPath: "/tmp/log" }) })
  );
  const sessions = listWorkerSessionsForIssue(issue.id);
  assert.equal(sessions.length, 3);
  assert.equal(sessions[2].role, "developer");
  assert.equal(sessions[2].round, 2);
  assert.equal(getIssue(issue.id)?.status, "repairing");
  assert.equal(getIssue(issue.id)?.currentRound, 2);
});

test("dirty worktree after developer session creates policy_escalation without consuming a round", async () => {
  const issue = seedIssue("Dirty worktree");
  await startIssueWorkflow(issue.id, fakeDeps());
  await advanceIssue(issue.id, fakeDeps({ isWorktreeClean: async () => false }));
  assert.equal(getIssue(issue.id)?.status, "needs_human");
  assert.equal(getIssue(issue.id)?.currentRound, 1);
  const actions = listOpenHumanActions();
  assert.ok(actions.some((a) => a.issueId === issue.id && a.actionType === "policy_escalation"));
});

test("every completed round emits workflow_events with the issue and round attached", async () => {
  const issue = seedIssue("Events issue");
  await startIssueWorkflow(issue.id, fakeDeps());
  await advanceIssue(issue.id, fakeDeps());
  const events = listWorkflowEventsForIssue(issue.id);
  assert.ok(events.some((e) => e.type === "workflow.started"));
  assert.ok(events.some((e) => e.type === "worker.started"));
  assert.ok(events.some((e) => e.type === "worker.completed"));
  assert.ok(events.some((e) => e.type === "pull_request.opened"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/server/src/coordinator/session-lifecycle.test.ts`
Expected: FAIL — `Cannot find module './session-lifecycle.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/server/src/coordinator/session-lifecycle.ts
import path from "node:path";
import os from "node:os";
import { v4 as uuid } from "uuid";
import type { Issue } from "@agent-dealer/shared";
import { getIssue, transitionIssue, incrementIssueRound } from "../repository/issues.js";
import { createWorkerSession, claimQueuedSession, completeSession, getWorkerSession } from "../repository/worker-sessions.js";
import { startWorkflowInstance, appendWorkflowEvent } from "../repository/workflow-events.js";
import { createHumanAction } from "../repository/human-actions.js";
import { reconcileFinding } from "../repository/findings.js";
import { addWorktree, removeWorktree, isWorktreeClean, mergeBase } from "../adapters/git-worktree.js";
import { viewPr, publishReview } from "../adapters/github.js";
import { spawnDeveloperSession, spawnReviewerSession } from "./spawn.js";
import { buildDeveloperPrompt, buildReviewerPrompt } from "./prompts.js";
import { parseReviewerResult } from "./reviewer-result.js";
import { routeDeveloperOutcome, routeReviewerOutcome, type DeveloperOutcome, type ReviewerOutcome } from "./routing.js";

export interface CoordinatorDeps {
  worktree: {
    addWorktree: typeof addWorktree;
    removeWorktree: typeof removeWorktree;
    isWorktreeClean: typeof isWorktreeClean;
    mergeBase: typeof mergeBase;
  };
  github: {
    viewPr: typeof viewPr;
    publishReview: typeof publishReview;
  };
  spawnDeveloper: typeof spawnDeveloperSession;
  spawnReviewer: typeof spawnReviewerSession;
}

export const defaultCoordinatorDeps: CoordinatorDeps = {
  worktree: { addWorktree, removeWorktree, isWorktreeClean, mergeBase },
  github: { viewPr, publishReview },
  spawnDeveloper: spawnDeveloperSession,
  spawnReviewer: spawnReviewerSession,
};

function worktreePathFor(issue: Issue, role: "developer" | "reviewer", round: number): string {
  return path.join(os.tmpdir(), "agent-dealer-worktrees", issue.id, `${role}-r${round}`);
}

export async function startIssueWorkflow(issueId: string, deps: CoordinatorDeps = defaultCoordinatorDeps): Promise<void> {
  const issue = getIssue(issueId);
  if (!issue) throw new Error(`Issue not found: ${issueId}`);

  const instance = startWorkflowInstance(issueId, "dev_reviewer_v1");
  appendWorkflowEvent({ issueId, workflowInstanceId: instance.id, type: "workflow.started", actorType: "system", stage: "ready" });

  const updated = transitionIssue(issueId, "developing", { currentOwner: "developer", currentIntent: "Developer implementing round 1" });

  const session = createWorkerSession({
    issueId,
    role: "developer",
    round: 1,
    agentId: issue.developerAgentId,
    runtime: "claude_code",
  });
  appendWorkflowEvent({
    issueId,
    workflowInstanceId: instance.id,
    workerSessionId: session.id,
    type: "worker.started",
    actorType: "system",
    stage: updated.status,
    round: 1,
  });
}

/** Claims and runs exactly one queued session for this issue to completion, then routes the outcome. */
export async function advanceIssue(issueId: string, deps: CoordinatorDeps = defaultCoordinatorDeps): Promise<void> {
  const issue = getIssue(issueId);
  if (!issue) throw new Error(`Issue not found: ${issueId}`);
  const { listWorkerSessionsForIssue } = await import("../repository/worker-sessions.js");
  const queued = listWorkerSessionsForIssue(issueId).filter((s) => s.status === "queued");
  const session = queued[queued.length - 1];
  if (!session) return;

  const claimed = claimQueuedSession(session.id);
  if (!claimed) return; // another dispatcher already took it

  const worktreePath = worktreePathFor(issue, session.role === "reviewer" ? "reviewer" : "developer", session.round);
  const instance = { id: undefined as string | undefined }; // instance id threading kept simple for round 1; real instance lookup happens via workflow_events in later plans if needed

  if (session.role === "developer") {
    await runDeveloperSession(issue, claimed, worktreePath, deps);
  } else {
    await runReviewerSession(issue, claimed, worktreePath, deps);
  }
}

async function runDeveloperSession(
  issue: Issue,
  session: ReturnType<typeof getWorkerSession> & object,
  worktreePath: string,
  deps: CoordinatorDeps
): Promise<void> {
  await deps.worktree.addWorktree({ repo: issue.repo, path: worktreePath, ref: issue.baseBranch, newBranch: `issue-${issue.id}` });

  const prompt = buildDeveloperPrompt({
    taskSnapshot: { title: issue.title, description: issue.description ?? "", acceptanceCriteria: issue.acceptanceCriteria ?? "", repo: issue.repo, baseBranch: issue.baseBranch },
    round: session!.round,
  });

  let result;
  try {
    result = await deps.spawnDeveloper(session!, prompt);
  } catch {
    result = { exitCode: 1, transcript: "", logPath: "", timedOut: false };
  }

  const sessionStatus = result.exitCode === 0 && !result.timedOut ? "done" : "failed";
  completeSession(session!.id, { status: sessionStatus, exitCode: result.exitCode, logPath: result.logPath });
  appendWorkflowEvent({ issueId: issue.id, workerSessionId: session!.id, type: "worker.completed", actorType: "developer", stage: issue.status, round: session!.round });

  const outcome = await classifyDeveloperOutcome(issue, worktreePath, sessionStatus, deps);
  const routed = routeDeveloperOutcome(outcome, { currentRound: issue.currentRound, maxReviewRounds: issue.maxReviewRounds });

  if (outcome.kind === "clean_handoff") {
    appendWorkflowEvent({ issueId: issue.id, workerSessionId: session!.id, type: "pull_request.opened", actorType: "system", stage: issue.status, round: session!.round, payload: { prNumber: outcome.prNumber, prUrl: outcome.prUrl, headSha: outcome.headSha } });
  }

  if (routed.next === "spawn_reviewer" && outcome.kind === "clean_handoff") {
    transitionIssue(issue.id, "reviewing", {
      currentOwner: "reviewer",
      currentIntent: "Reviewer evaluating PR",
      headSha: outcome.headSha,
      baseSha: outcome.baseSha,
      prNumber: outcome.prNumber,
      prUrl: outcome.prUrl,
    });
    createWorkerSession({ issueId: issue.id, role: "reviewer", round: session!.round, agentId: issue.reviewerAgentId, runtime: "claude_code", inputSha: outcome.headSha });
  } else if (routed.next === "retry_developer") {
    incrementIssueRound(issue.id);
    const next = getIssue(issue.id)!;
    createWorkerSession({ issueId: issue.id, role: "developer", round: next.currentRound, agentId: issue.developerAgentId, runtime: "claude_code" });
  } else if (routed.next === "human_action") {
    transitionIssue(issue.id, "needs_human", { currentOwner: "human" });
    createHumanAction({ issueId: issue.id, actionType: routed.actionType, reason: routed.reason, question: routed.reason });
  }

  if (outcome.kind !== "dirty_worktree") {
    await deps.worktree.removeWorktree({ repo: issue.repo, path: worktreePath, force: false }).catch(() => undefined);
  }
}

async function classifyDeveloperOutcome(
  issue: Issue,
  worktreePath: string,
  sessionStatus: "done" | "failed",
  deps: CoordinatorDeps
): Promise<DeveloperOutcome> {
  if (sessionStatus === "failed") return { kind: "session_failed" };
  const clean = await deps.worktree.isWorktreeClean(worktreePath);
  if (!clean) return { kind: "dirty_worktree" };
  try {
    const view = await deps.github.viewPr({ cwd: worktreePath });
    const baseSha = await deps.worktree.mergeBase({ repo: worktreePath, base: view.baseRefName, head: view.headRefName });
    return { kind: "clean_handoff", headSha: view.headRefOid, baseSha, prNumber: view.number, prUrl: view.url };
  } catch {
    return { kind: "no_pr" };
  }
}

async function runReviewerSession(
  issue: Issue,
  session: ReturnType<typeof getWorkerSession> & object,
  worktreePath: string,
  deps: CoordinatorDeps
): Promise<void> {
  await deps.worktree.addWorktree({ repo: issue.repo, path: worktreePath, ref: session!.inputSha ?? issue.headSha ?? issue.baseBranch, detach: true });

  const prompt = buildReviewerPrompt({
    taskSnapshot: { title: issue.title, description: issue.description ?? "", acceptanceCriteria: issue.acceptanceCriteria ?? "", repo: issue.repo, baseBranch: issue.baseBranch },
    baseSha: issue.baseSha ?? "",
    headSha: session!.inputSha ?? issue.headSha ?? "",
  });

  let result;
  try {
    result = await deps.spawnReviewer(session!, prompt);
  } catch {
    result = { exitCode: 1, transcript: "", logPath: "", timedOut: false };
  }

  const sessionStatus = result.exitCode === 0 && !result.timedOut ? "done" : "failed";
  completeSession(session!.id, { status: sessionStatus, exitCode: result.exitCode, logPath: result.logPath });
  appendWorkflowEvent({ issueId: issue.id, workerSessionId: session!.id, type: "worker.completed", actorType: "reviewer", stage: issue.status, round: session!.round });

  const outcome = await classifyReviewerOutcome(issue, session!, worktreePath, sessionStatus, result.transcript, deps);
  const routed = routeReviewerOutcome(outcome, { currentRound: issue.currentRound, maxReviewRounds: issue.maxReviewRounds });

  if (outcome.kind === "verdict") {
    appendWorkflowEvent({ issueId: issue.id, workerSessionId: session!.id, type: "review.submitted", actorType: "reviewer", stage: issue.status, round: session!.round, payload: outcome.result });
    for (const f of outcome.result.findings) {
      reconcileFinding({ issueId: issue.id, fingerprint: f.fingerprint, severity: f.severity, title: f.title, rationale: f.rationale, file: f.file, line: f.line, round: session!.round });
    }
  }

  if (routed.next === "final_review") {
    transitionIssue(issue.id, "final_review", { currentOwner: "human" });
    createHumanAction({ issueId: issue.id, actionType: "final_review", reason: "Reviewer approved the PR", question: "Accept this work?" });
  } else if (routed.next === "retry_developer_with_findings") {
    transitionIssue(issue.id, "repairing", { currentOwner: "developer" });
    incrementIssueRound(issue.id);
    const next = getIssue(issue.id)!;
    createWorkerSession({ issueId: issue.id, role: "developer", round: next.currentRound, agentId: issue.developerAgentId, runtime: "claude_code" });
    appendWorkflowEvent({ issueId: issue.id, type: "repair.started", actorType: "system", stage: next.status, round: next.currentRound });
  } else if (routed.next === "retry_reviewer_same_head") {
    createWorkerSession({ issueId: issue.id, role: "reviewer", round: session!.round, agentId: issue.reviewerAgentId, runtime: "claude_code", inputSha: issue.headSha });
  } else if (routed.next === "human_action") {
    transitionIssue(issue.id, "needs_human", { currentOwner: "human" });
    createHumanAction({ issueId: issue.id, actionType: routed.actionType, reason: routed.reason, question: routed.reason });
  }

  await deps.worktree.removeWorktree({ repo: issue.repo, path: worktreePath, force: true }).catch(() => undefined);
}

async function classifyReviewerOutcome(
  issue: Issue,
  session: NonNullable<ReturnType<typeof getWorkerSession>>,
  worktreePath: string,
  sessionStatus: "done" | "failed",
  transcript: string,
  deps: CoordinatorDeps
): Promise<ReviewerOutcome> {
  if (sessionStatus === "failed") return { kind: "session_failed" };

  const view = await deps.github.viewPr({ cwd: worktreePath }).catch(() => null);
  if (view && session.inputSha && view.headRefOid !== session.inputSha) {
    return { kind: "stale", currentHeadSha: view.headRefOid };
  }

  const parsed = parseReviewerResult(transcript);
  if (!parsed) return { kind: "session_failed" };

  if (issue.prNumber) {
    const event = parsed.verdict === "approved" ? "APPROVE" : parsed.verdict === "changes_requested" ? "REQUEST_CHANGES" : "COMMENT";
    const bodyFile = path.join(os.tmpdir(), `review-${uuid()}.md`);
    const fs = await import("node:fs");
    fs.writeFileSync(bodyFile, transcript);
    const published = await deps.github.publishReview({ cwd: worktreePath, prNumber: issue.prNumber, event, bodyFilePath: bodyFile });
    if (!published.ok) return { kind: "publish_failed" };
  }

  return { kind: "verdict", result: parsed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/server/src/coordinator/session-lifecycle.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full server test suite, then commit**

```bash
npx tsx --test $(find packages/server -name '*.test.ts')
git add packages/server/src/coordinator/session-lifecycle.ts packages/server/src/coordinator/session-lifecycle.test.ts
git commit -m "Add coordinator session-lifecycle orchestrator (NOT-57)"
```

**Amendments (found running this task; all are bugs/smells in the plan's own Task 6 code, not schema gaps):**

1. **Real bug — repair rounds never told the developer what to fix.** `runDeveloperSession` called `buildDeveloperPrompt` without ever passing `findings`, even when routed via `retry_developer_with_findings`. `prompts.ts` (Task 3) was built and tested specifically to surface prior blocking findings on repair rounds (`"buildDeveloperPrompt includes prior findings on a repair round"`), and `routing.ts`'s own next-step name (`retry_developer_with_findings`) states the intent directly — but the plan's `session-lifecycle.ts` never wired the two together, so round 2+ developer sessions would run with zero visibility into what the reviewer flagged. Fixed by fetching `listFindingsForIssue(issue.id)` (already-existing Task-1-plan repository function), filtering to `status === "open" || status === "recurring"`, and passing the result into `buildDeveloperPrompt`. None of the six `session-lifecycle.test.ts` assertions check prompt content, so this didn't surface as a test failure — confirmed instead with a manual smoke run showing the round-2 prompt now contains the finding's title and rationale.

2. **Dead code — the unused `instance` variable in `advanceIssue`.** The plan's code declared `const instance = { id: undefined as string | undefined };` and never referenced it anywhere. Investigated the hypothesis (raised going into this task) that this meant `workflow_instance_id` wasn't being threaded into `appendWorkflowEvent` calls from `advanceIssue`'s callees — that's true (only the two events emitted directly inside `startIssueWorkflow` carry a `workflowInstanceId`; every event from `runDeveloperSession`/`runReviewerSession` omits it), but the inline comment on that same line (`"instance id threading kept simple for round 1... in later plans if needed"`) shows this was a deliberate, acknowledged simplification by the plan's author, not an oversight — and there is no repository function yet to look up an issue's active `workflow_instance_id` from just an `issueId` (only `startWorkflowInstance`/`completeWorkflowInstance`/`appendWorkflowEvent`/`listWorkflowEventsForIssue` exist), so "properly" threading it would mean adding new plumbing not scoped to this task. Removed the dead variable itself; left the (intentionally deferred) non-threading behavior as designed.

3. **Type-cast smell.** `runDeveloperSession` and `runReviewerSession` typed their `session` parameter as `ReturnType<typeof getWorkerSession> & object` — a workaround that happens to reduce to plain `WorkerSession` via TS's intersection-with-primitive-`null` behavior, but reads as a hack and forced every use site to add a now-redundant `session!.` non-null assertion. Replaced both occurrences (and the equivalent `NonNullable<ReturnType<typeof getWorkerSession>>` in `classifyReviewerOutcome`) with a plain `WorkerSession` type imported from `@agent-dealer/shared`; dropped the now-unused `getWorkerSession` import. Purely a type-level change — identical runtime behavior.

4. **Minor cleanup.** `advanceIssue` did a function-scoped dynamic `await import("../repository/worker-sessions.js")` to get `listWorkerSessionsForIssue`, even though `createWorkerSession`/`claimQueuedSession`/`completeSession` from the same module are already static top-level imports and there's no circular-dependency reason for the dynamic form. Hoisted it to the existing top-level import.

---

### Task 7: Dispatch loop + crash recovery

**Files:**
- Create: `packages/server/src/coordinator/dispatcher.ts`
- Test: `packages/server/src/coordinator/dispatcher.test.ts`

**Interfaces:**
- Consumes: `listIssues` (`../repository/issues.js`); `listWorkerSessionsForIssue`, `completeSession` (`../repository/worker-sessions.js`); `advanceIssue` (`./session-lifecycle.js`); `isWorktreeClean`, `removeWorktree`, `pruneWorktrees` (`../adapters/git-worktree.js`)
- Produces: `async function pollAndDispatch(deps?: CoordinatorDeps): Promise<void>` — advances every issue with a queued session; `function reconcileStaleSessions(staleThresholdMs: number): { reconciled: string[] }` — marks stuck `running` sessions failed and re-routes them; `async function recoverWorktree(session: WorkerSession, deps?: CoordinatorDeps): Promise<"removed" | "escalated">`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/src/coordinator/dispatcher.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-dispatcher-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { createWorkerSession, getWorkerSession } = await import("../repository/worker-sessions.js");
const { createHumanAction } = await import("../repository/human-actions.js");
const { reconcileStaleSessions } = await import("./dispatcher.js");

before(() => {
  migrate();
});

function seedIssue() {
  return createIssue({
    title: "Dispatcher issue",
    repo: "/tmp/fake-repo",
    baseBranch: "main",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    maxReviewRounds: 3,
    source: "manual",
  });
}

test("reconcileStaleSessions marks a stuck running developer session as failed", () => {
  const issue = seedIssue();
  const session = createWorkerSession({ issueId: issue.id, role: "developer", round: 1, agentId: BUILTIN_AGENT_CLAUDE_ID, runtime: "claude_code" });

  // Simulate: claimed (running) a long time ago, heartbeat stale, process gone.
  const db = (await import("../db/index.js")).getDb();
  const staleTime = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  db.prepare("UPDATE worker_sessions SET status = 'running', started_at = ?, heartbeat_at = ? WHERE id = ?").run(staleTime, staleTime, session.id);

  const result = reconcileStaleSessions(60 * 60_000);
  assert.ok(result.reconciled.includes(session.id));
  assert.equal(getWorkerSession(session.id)?.status, "failed");
});

test("reconcileStaleSessions ignores sessions with a recent heartbeat", () => {
  const issue = seedIssue();
  const session = createWorkerSession({ issueId: issue.id, role: "developer", round: 1, agentId: BUILTIN_AGENT_CLAUDE_ID, runtime: "claude_code" });
  const db = (await import("../db/index.js")).getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE worker_sessions SET status = 'running', started_at = ?, heartbeat_at = ? WHERE id = ?").run(now, now, session.id);

  const result = reconcileStaleSessions(60 * 60_000);
  assert.equal(result.reconciled.includes(session.id), false);
  assert.equal(getWorkerSession(session.id)?.status, "running");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/server/src/coordinator/dispatcher.test.ts`
Expected: FAIL — `Cannot find module './dispatcher.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/server/src/coordinator/dispatcher.ts
import { getDb } from "../db/index.js";
import { listIssues } from "../repository/issues.js";
import { advanceIssue, type CoordinatorDeps } from "./session-lifecycle.js";
import { removeWorktree, isWorktreeClean, pruneWorktrees } from "../adapters/git-worktree.js";
import { createHumanAction } from "../repository/human-actions.js";
import type { WorkerSession } from "@agent-dealer/shared";

/** Advances every issue that has a queued session. Safe to call on a timer. */
export async function pollAndDispatch(deps?: CoordinatorDeps): Promise<void> {
  const active = listIssues(["ready", "developing", "reviewing", "repairing"]);
  for (const issue of active) {
    await advanceIssue(issue.id, deps).catch((err) => {
      // A single issue's failure must not stop the poll loop from advancing others.
      console.error(`advanceIssue(${issue.id}) failed:`, err);
    });
  }
}

export interface ReconcileResult {
  reconciled: string[];
}

/** Marks `running` worker_sessions with a stale heartbeat as failed — crash recovery. */
export function reconcileStaleSessions(staleThresholdMs: number): ReconcileResult {
  const db = getDb();
  const cutoff = new Date(Date.now() - staleThresholdMs).toISOString();
  const stale = db
    .prepare("SELECT id FROM worker_sessions WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)")
    .all(cutoff) as Array<{ id: string }>;

  const now = new Date().toISOString();
  const reconciled: string[] = [];
  for (const row of stale) {
    db.prepare("UPDATE worker_sessions SET status = 'failed', completed_at = ?, updated_at = ?, error_json = ? WHERE id = ?").run(
      now,
      now,
      JSON.stringify({ reason: "stale heartbeat — process presumed dead" }),
      row.id
    );
    reconciled.push(row.id);
  }
  return { reconciled };
}

/**
 * Crash recovery for a leftover worktree: a missing path is a no-op, a clean checkout
 * is pruned, a dirty/unpushed developer worktree is preserved and escalated — never
 * force-removed, since it may hold unrecovered work.
 */
export async function recoverWorktree(session: WorkerSession, issueId: string): Promise<"removed" | "escalated" | "missing"> {
  if (!session.worktreePath) return "missing";
  const fs = await import("node:fs");
  if (!fs.existsSync(session.worktreePath)) return "missing";

  const clean = await isWorktreeClean(session.worktreePath).catch(() => false);
  if (clean) {
    await removeWorktree({ repo: session.worktreePath, path: session.worktreePath, force: false }).catch(() => undefined);
    return "removed";
  }
  createHumanAction({
    issueId,
    actionType: "policy_escalation",
    reason: `Recovered a dirty worktree at ${session.worktreePath} from session ${session.id} — preserved, not removed.`,
    question: "This worktree has uncommitted or unpushed changes from a crashed session. Inspect and resolve manually.",
    evidence: { worktreePath: session.worktreePath, sessionId: session.id },
  });
  return "escalated";
}

export async function pruneCleanWorktreesForRepo(repo: string): Promise<void> {
  await pruneWorktrees(repo).catch(() => undefined);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/server/src/coordinator/dispatcher.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the full server test suite, then commit**

```bash
npx tsx --test $(find packages/server -name '*.test.ts')
git add packages/server/src/coordinator/dispatcher.ts packages/server/src/coordinator/dispatcher.test.ts
git commit -m "Add coordinator dispatch loop and crash recovery (NOT-57)"
```

---

### Task 8: Reflect trigger on final_review completion

**Files:**
- Create: `packages/server/src/coordinator/reflect-trigger.ts`
- Test: `packages/server/src/coordinator/reflect-trigger.test.ts`

**Interfaces:**
- Consumes: `checkAgentDeckHealth`, `fetchPlaybook`, `proposePlaybookPatch` (`../adapters/agent-deck.js` — already exist, already deck/playbook-id-keyed rather than `Run`-keyed, per the spec's finding that only the `Run`-shaped prompt builders needed replacing, not the deck adapter calls themselves); `appendWorkflowEvent` (`../repository/workflow-events.js`); `listFindingsForIssue` (`../repository/findings.js`); `getIssue` (`../repository/issues.js`)
- Produces: `async function triggerReflectOnComplete(issueId: string, developerAgentDeckId: string | null, developerAgentPlaybookId: string | null): Promise<"triggered" | "skipped">`

Per the spec, this fires only when a human resolves `final_review` as complete — not on automatic repairs, `attempts_exhausted`, or `policy_escalation`. This task builds the trigger function itself; wiring it to the actual human-action-resolve API call happens in Plan 3 (the `/api/human-actions/:id/resolve` route calls this when `actionType === "final_review"` and the resolution is `"complete"`).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/src/coordinator/reflect-trigger.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-reflect-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("../repository/issues.js");
const { listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
const { triggerReflectOnComplete } = await import("./reflect-trigger.js");

before(() => {
  migrate();
});

test("skips when no deck/playbook is configured for the developer profile", async () => {
  const issue = createIssue({
    title: "No deck",
    repo: "/tmp/fake-repo",
    baseBranch: "main",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    maxReviewRounds: 3,
    source: "manual",
  });
  const result = await triggerReflectOnComplete(issue.id, null, null);
  assert.equal(result, "skipped");
  assert.equal(listWorkflowEventsForIssue(issue.id).length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/server/src/coordinator/reflect-trigger.test.ts`
Expected: FAIL — `Cannot find module './reflect-trigger.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/server/src/coordinator/reflect-trigger.ts
import { checkAgentDeckHealth, fetchPlaybook, proposePlaybookPatch } from "../adapters/agent-deck.js";
import { appendWorkflowEvent } from "../repository/workflow-events.js";
import { listFindingsForIssue } from "../repository/findings.js";
import { getIssue } from "../repository/issues.js";

/**
 * Fires once per completed workflow instance, only when the human resolves final_review
 * as complete — the closest analog to today's "approve" reflect trigger. Automatic
 * per-round repairs, attempts_exhausted, and policy_escalation never call this.
 */
export async function triggerReflectOnComplete(
  issueId: string,
  developerAgentDeckId: string | null,
  developerAgentPlaybookId: string | null
): Promise<"triggered" | "skipped"> {
  if (!developerAgentDeckId || !developerAgentPlaybookId) return "skipped";

  const issue = getIssue(issueId);
  if (!issue) return "skipped";

  const healthy = await checkAgentDeckHealth().catch(() => false);
  if (!healthy) {
    appendWorkflowEvent({ issueId, type: "issue.completed", actorType: "system", stage: issue.status, payload: { reflect: "skipped", reason: "Agent Deck offline" } });
    return "skipped";
  }

  const playbook = await fetchPlaybook(developerAgentPlaybookId);
  const findings = listFindingsForIssue(issueId);
  const resolvedCount = findings.filter((f) => f.status === "resolved").length;

  const rationale = `Issue "${issue.title}" completed with ${findings.length} finding(s) tracked across rounds (${resolvedCount} resolved). Playbook: ${playbook.title}.`;

  const created = await proposePlaybookPatch(developerAgentDeckId, issueId, {
    ops: [],
    rationale,
    evidence: { failure_summary: undefined, user_feedback_excerpt: undefined },
    playbook_id: developerAgentPlaybookId,
  });

  appendWorkflowEvent({
    issueId,
    type: "issue.completed",
    actorType: "system",
    stage: issue.status,
    payload: { reflect: "triggered", patchId: created.id },
  });
  return "triggered";
}
```

**Note for the implementer:** `proposePlaybookPatch`'s real payload shape should be double-checked against `packages/server/src/adapters/agent-deck.ts` and `packages/server/src/runners/reflect.ts`'s existing call (`proposePlaybookPatch(run.deckId, run.id, {...})`) before wiring this up — the `ops: []` placeholder here means "let the reflect call itself decide what to propose," which may not match the real adapter's expected shape. This is flagged explicitly rather than guessed at, since the existing `runReflect` in `reflect.ts` actually runs a whole Claude session to generate the `ops` array — this task's version does not spawn a session, so it's a simplified variant, not a full parity implementation. Revisit before this ships to production; the test above only covers the "skipped" path for that reason.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/server/src/coordinator/reflect-trigger.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Run the full server test suite, then commit**

```bash
npx tsx --test $(find packages/server -name '*.test.ts')
git add packages/server/src/coordinator/reflect-trigger.ts packages/server/src/coordinator/reflect-trigger.test.ts
git commit -m "Add reflect trigger on final_review completion (NOT-57)"
```

---

## Plan Self-Review Notes

- **Spec coverage:** Session lifecycle steps 1–7, worktree lifecycle/concurrency, role permissions (developer read/write/bash vs reviewer read-only tools), GitHub access via `--body-file`, durable dispatch/recovery, and the reflect trigger all have a task. Guidance semantics (spec's "Guidance" section) and the `product_scope_decision` pre-start validation (spec step 1's "If required product intent cannot be normalized without guessing") are **not** implemented here — they're additive to `startIssueWorkflow` and belong with Plan 3's API layer, since guidance is appended via an API call, not a coordinator-internal concern.
- **Known simplification flagged inline:** `reflect-trigger.ts`'s `ops: []` payload is explicitly noted as needing revisit — it doesn't run a full reflect session the way `runReflect` does for legacy runs, since spawning a whole additional session for this was judged out of scope for getting the coordinator loop working end-to-end. This is a real, flagged gap, not a silently accepted placeholder.
- **Type consistency check:** `DeveloperOutcome`/`ReviewerOutcome` (Task 4) match exactly what `session-lifecycle.ts` (Task 6) constructs in `classifyDeveloperOutcome`/`classifyReviewerOutcome`. `ReviewerResult` (Task 3) is the same type threaded through `routing.ts` (Task 4) and `session-lifecycle.ts` (Task 6). `CoordinatorDeps` (Task 6) matches the fake shape built in `session-lifecycle.test.ts` and is what `dispatcher.ts` (Task 7) forwards through `pollAndDispatch`.
- **Deferred to Plan 3:** the actual scheduling of `pollAndDispatch`/`reconcileStaleSessions` on a timer (today's `dispatcher.ts` uses `setInterval`-based polling — this plan builds the functions but doesn't wire a timer, since starting a background timer from a library module has side effects better owned by the server's startup code in a later plan).
