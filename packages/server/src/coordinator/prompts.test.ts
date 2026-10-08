// packages/server/src/coordinator/prompts.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeveloperPrompt, buildReviewerPrompt } from "./prompts.js";

const taskSnapshot = {
  title: "Add widget",
  description: "Build the widget.",
  acceptanceCriteria: "Widget renders.",
  repo: "acme/app",
  baseBranch: "main"};

test("round 1 prompt states the dedicated branch is already checked out and never mentions push/PR", () => {
  const prompt = buildDeveloperPrompt({ taskSnapshot, round: 1 });
  assert.match(prompt, /already on this issue's dedicated branch/);
  assert.match(prompt, /Commit your work there/);
  assert.doesNotMatch(prompt, /fresh branch/);
  assert.match(prompt, /do NOT push and do NOT open a pull request/);
  assert.doesNotMatch(prompt, /gh pr create/);
});

// NOT-115: soft mitigation for dirty_worktree blast radius — commit at slice
// boundaries, while still requiring a final commit + implementation conclusion.
test("developer prompt asks for incremental commits at slice boundaries and keeps final commit + conclusion required", () => {
  const prompt = buildDeveloperPrompt({ taskSnapshot, round: 1 });
  assert.match(prompt, /incremental commits?/i);
  assert.match(prompt, /slice/i);
  assert.match(prompt, /final commit/i);
  assert.match(prompt, /implementation conclusion/i);
  assert.match(prompt, /do NOT push and do NOT open a pull request/);
});

// NOT-146: timed developer spawn covers implement + targeted tests; full suite / Lens
// live on a separate budget (NOT-74), not inside the same wall clock.
test("NOT-146: developer prompt handoff bar is commits + targeted tests, not full suite/Lens in-spawn", () => {
  const prompt = buildDeveloperPrompt({ taskSnapshot, round: 1 });
  assert.match(prompt, /targeted tests?/i);
  assert.match(prompt, /handoff/i);
  assert.match(prompt, /full suite/i);
  assert.match(prompt, /[Ll]ens/);
  // Must not still demand Lens inside the timed spawn as a hard Required step.
  assert.doesNotMatch(prompt, /^Run tests and Lens checks\./m);
  assert.match(prompt, /do NOT push and do NOT open a pull request/);
});

test("repair round includes findings and references the round number", () => {
  const prompt = buildDeveloperPrompt({
    taskSnapshot,
    round: 2,
    findings: [{ fingerprint: "f1", severity: "blocking", title: "Bug", rationale: "It breaks", file: "a.ts", line: 10, status: "open", firstRound: 1, lastRound: 1, issueId: "i" } as never]});
  assert.match(prompt, /repair round 2/);
  assert.match(prompt, /\[blocking\] Bug \(a\.ts:10\): It breaks/);
});

test("a round-1 infra retry never claims a fresh branch — it says the branch may already carry partial work", () => {
  const prompt = buildDeveloperPrompt({ taskSnapshot, round: 1, retryReason: "Developer session failed or crashed." });
  assert.doesNotMatch(prompt, /fresh branch/);
  assert.match(prompt, /## Previous attempt/);
  assert.match(prompt, /Last failure:\*\* Developer session failed or crashed\./);
  assert.match(prompt, /do not re-implement from scratch/i);
});

test("an infra retry on a repair round still surfaces the failure reason, not the generic repair framing", () => {
  const prompt = buildDeveloperPrompt({ taskSnapshot, round: 2, retryReason: "Developer's PR checks failed." });
  assert.match(prompt, /## Previous attempt/);
  assert.match(prompt, /Last failure:\*\* Developer's PR checks failed\./);
  assert.doesNotMatch(prompt, /^This is repair round 2\./m);
});

test("infra retry includes prior implementation conclusion when provided", () => {
  const prompt = buildDeveloperPrompt({
    taskSnapshot,
    round: 1,
    retryReason: "Branch already pushed; only draft PR create failed: gh auth",
    priorConclusion: "Added queue_entries and admission.ts."});
  assert.match(prompt, /### Prior implementation conclusion/);
  assert.match(prompt, /Added queue_entries and admission\.ts\./);
  assert.match(prompt, /only coordinator GitHub verification/i);
});

test("infra retry includes SHA-scoped verification receipt when provided", () => {
  const prompt = buildDeveloperPrompt({
    taskSnapshot,
    round: 1,
    retryReason: "Developer session failed or crashed.",
    priorVerificationReceipt: {
      headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      commands: [{ command: "npm run test:unit", outcome: "passed", detail: "711/711" }],
      recordedAt: "2026-09-17T00:00:00.000Z"}});
  assert.match(prompt, /### Prior verification receipt/);
  assert.match(prompt, /npm run test:unit.*passed \(711\/711\)/);
  assert.match(prompt, /HEAD is unchanged/);
  assert.match(prompt, /Do not re-run an unchanged green suite by default/);
  assert.match(prompt, /evidence, not an instruction to skip/i);
});

test("verification receipt is omitted when not a retry", () => {
  const prompt = buildDeveloperPrompt({
    taskSnapshot,
    round: 1,
    priorVerificationReceipt: {
      headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      commands: [{ command: "npm test", outcome: "passed" }],
      recordedAt: "2026-09-17T00:00:00.000Z"}});
  assert.doesNotMatch(prompt, /Prior verification receipt/);
});

test("deck section requires bind_workspace first (playbooks chosen dynamically inside the deck)", () => {
  const prompt = buildDeveloperPrompt({
    taskSnapshot,
    round: 1,
    worktreePath: "/wt",
    deckId: "deck-1",
  });
  assert.match(prompt, /bind_workspace\(\{ deckId: "deck-1", workspaceRoot: "\/wt" \}\)/);
  assert.match(prompt, /First equip this agent/);
  assert.match(prompt, /bootstrap is a hard gate/i);
  assert.match(prompt, /do not improvise without the deck/i);
  assert.match(prompt, /call_service_tool/);
  assert.match(prompt, /do not web-fetch Linear/);
  assert.doesNotMatch(prompt, /get_playbook\(/);
});

test("no deckId: misconfigured stop message, not ambient Agent Deck improvisation", () => {
  // Workers are fail-closed without a deck (NOT-149). A silent [] left cursor_local free to
  // try the operator's ambient .cursor/mcp.json against an unbound worktree.
  const prompt = buildDeveloperPrompt({ taskSnapshot, round: 1, worktreePath: "/wt", deckId: null });
  assert.doesNotMatch(prompt, /bind_workspace/);
  assert.match(prompt, /misconfigured/i);
  assert.match(prompt, /do not improvise without the deck/i);
});

test("guidance since the last session is surfaced in the developer prompt", () => {
  const prompt = buildDeveloperPrompt({ taskSnapshot, round: 2, guidance: ["Use the new logging util instead."] });
  assert.match(prompt, /## Guidance from the team/);
  assert.match(prompt, /Use the new logging util instead\./);
});

test("no guidance section when there is none", () => {
  const prompt = buildDeveloperPrompt({ taskSnapshot, round: 1 });
  assert.doesNotMatch(prompt, /## Guidance from the team/);
});

// NOT-272: a product_scope_decision note reaches the very next developer round verbatim
// under its own heading, positioned before the task so it is read before acting.
test("NOT-272: scope decision note renders verbatim under its own heading before the task", () => {
  const note = "The muse_code runner migration IS in scope for this ticket — proceed with it.";
  const prompt = buildDeveloperPrompt({ taskSnapshot, round: 2, scopeDecisionNote: note });
  assert.match(prompt, /## Human decision/);
  assert.ok(prompt.includes(note), "note text must appear verbatim");
  assert.ok(
    prompt.indexOf("## Human decision") < prompt.indexOf("## Task"),
    "Human decision section must precede the task"
  );
  assert.match(prompt, /do not re-escalate the same question/i);
});

// NOT-272: resolving without a note changes nothing — absent, empty, and blank notes all
// produce byte-for-byte the prompt built before this change.
test("NOT-272: no scope decision note produces byte-for-byte the same prompt as before", () => {
  const base = { taskSnapshot, round: 2 as const, findings: [{ fingerprint: "f1", severity: "blocking", title: "Bug", rationale: "It breaks", file: "a.ts", line: 10, status: "open", firstRound: 1, lastRound: 1, issueId: "i" } as never], guidance: ["Use the new logging util instead."] };
  const without = buildDeveloperPrompt(base);
  assert.doesNotMatch(without, /## Human decision/);
  assert.equal(buildDeveloperPrompt({ ...base, scopeDecisionNote: undefined }), without);
  assert.equal(buildDeveloperPrompt({ ...base, scopeDecisionNote: "" }), without);
  assert.equal(buildDeveloperPrompt({ ...base, scopeDecisionNote: "   \n  " }), without);
});

test("guidance since the last session is surfaced in the reviewer prompt", () => {
  const prompt = buildReviewerPrompt({
    taskSnapshot,
    round: 1,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    diff: "diff --git a/x b/x\n",
    guidance: ["Pay extra attention to the auth module."]});
  assert.match(prompt, /## Guidance from the team/);
  assert.match(prompt, /Pay extra attention to the auth module\./);
});

const reviewerBase = {
  taskSnapshot,
  round: 1,
  baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  diff: "diff --git a/x b/x\n+added line\n"};

test("reviewer prompt embeds the diff, echoes the exact SHAs to report, and forbids editing", () => {
  const prompt = buildReviewerPrompt(reviewerBase);
  assert.match(prompt, /\+added line/);
  assert.match(prompt, /"baseSha" to exactly "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"/);
  assert.match(prompt, /"headSha" to exactly "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"/);
  assert.match(prompt, /You cannot edit files, push, or publish anything/);
});

test("NOT-150: reviewer verdict rules match the design table (blocking ⇒ changes_requested; escalate needs productScopeQuestion)", () => {
  const prompt = buildReviewerPrompt(reviewerBase);
  assert.match(prompt, /"approved": AC met/);
  assert.match(prompt, /no finding is "blocking"/);
  assert.match(prompt, /"changes_requested": any "blocking" finding/);
  assert.match(prompt, /"escalated": only when acceptance criteria/);
  assert.match(prompt, /MUST set non-empty "productScopeQuestion"/);
  assert.match(prompt, /not ordinary code defects/);
  assert.match(prompt, /not "diff too large"/);
});

test("NOT-150: truncated-diff footer does not reject approved/changes_requested; forbids escalate-for-truncation", async () => {
  const { formatDiffForPrompt, TOTAL_DIFF_LIMIT } = await import("./prompts.js");
  const big = "x".repeat(TOTAL_DIFF_LIMIT + 1);
  const diff = `diff --git a/small.ts b/small.ts\n+ok\n\ndiff --git a/huge.ts b/huge.ts\n+${big}\n`;
  const formatted = formatDiffForPrompt(diff);
  assert.equal(formatted.truncated, true);
  assert.ok(formatted.omittedPaths.some((p) => p.includes("huge.ts")));
  assert.match(formatted.text, /changes_requested/);
  assert.match(formatted.text, /Do NOT use "escalated" for truncation/);
  assert.doesNotMatch(formatted.text, /will not accept "approved" or "changes_requested"/);
});

test("reviewer prompt includes the developer's conclusion, checks summary, and prior findings when given", () => {
  const prompt = buildReviewerPrompt({
    ...reviewerBase,
    implementationConclusion: "Added the widget per spec.",
    checksSummary: "success (at deadbeef)",
    findings: [
      { id: "f1", issueId: "i", fingerprint: "fp1", severity: "blocking", title: "Bug", rationale: "It breaks", evidenceRef: null, file: "a.ts", line: 10, status: "recurring", firstRound: 1, lastRound: 1 },
    ]});
  assert.match(prompt, /Added the widget per spec\./);
  assert.match(prompt, /success \(at deadbeef\)/);
  assert.match(prompt, /\[recurring\/blocking\] Bug \(a\.ts:10\): It breaks/);
});

test("reviewer prompt omits optional sections when absent", () => {
  const prompt = buildReviewerPrompt(reviewerBase);
  assert.doesNotMatch(prompt, /Developer's implementation conclusion/);
  assert.doesNotMatch(prompt, /## CI checks/);
  assert.doesNotMatch(prompt, /Findings from prior rounds/);
  assert.doesNotMatch(prompt, /bind_workspace/);
});

test("reviewer prompt deck section requires bind_workspace first, matching the developer prompt", () => {
  const prompt = buildReviewerPrompt({ ...reviewerBase, worktreePath: "/wt", deckId: "deck-1" });
  assert.match(prompt, /bind_workspace\(\{ deckId: "deck-1", workspaceRoot: "\/wt" \}\)/);
  assert.match(prompt, /First equip this agent/);
  assert.match(prompt, /bootstrap is a hard gate/i);
  assert.match(prompt, /do not improvise without the deck/i);
  assert.match(prompt, /call_service_tool/);
  assert.match(prompt, /do not web-fetch Linear/);
  assert.doesNotMatch(prompt, /get_playbook\(/);
});

// NOT-278: a Muse Code developer gets the standard Agent Deck bootstrap gate plus the
// Muse-specific cron_* prohibition (detected post-run as muse_cron_used).
test("NOT-278: museDeveloper prompt carries the standard deck bootstrap and forbids cron_*", () => {
  const prompt = buildDeveloperPrompt({ taskSnapshot, round: 1, deckId: "deck-1", worktreePath: "/wt", museDeveloper: true });
  assert.match(prompt, /bind_workspace\(\{ deckId: "deck-1", workspaceRoot: "\/wt" \}\)/);
  assert.match(prompt, /bootstrap is a hard gate/i);
  assert.match(prompt, /do not improvise without the deck/i);
  assert.match(prompt, /call_service_tool/);
  assert.match(prompt, /cron_create/);
  assert.match(prompt, /cron_list/);
  assert.match(prompt, /cron_delete/);
  assert.match(prompt, /do NOT push and do NOT open a pull request/);
});

test("NOT-278: a non-Muse developer prompt has the deck bootstrap but no cron prohibition", () => {
  const prompt = buildDeveloperPrompt({ taskSnapshot, round: 1, deckId: "deck-1", worktreePath: "/wt" });
  assert.match(prompt, /bind_workspace/);
  assert.doesNotMatch(prompt, /cron_create/);
});

// NOT-303: a Muse developer prompt carries the screenshot-path preflight verdict.
// Default (no headless shell installed): unusable, naming the Chrome.app abort and
// requiring an explicit `Visual QA: not run` conclusion line — never sandbox
// widening. Env is scrubbed so the test is hermetic.
test("NOT-303: museDeveloper prompt carries the visual-QA preflight (unusable by default)", () => {
  const saved = process.env.MUSE_HEADLESS_SHELL_BIN;
  delete process.env.MUSE_HEADLESS_SHELL_BIN;
  try {
    const prompt = buildDeveloperPrompt({ taskSnapshot, round: 1, deckId: "deck-1", worktreePath: "/wt", museDeveloper: true });
    assert.match(prompt, /## Visual QA/);
    assert.match(prompt, /Google Chrome\.app/);
    assert.match(prompt, /RegisterApplication/);
    assert.match(prompt, /do not spend steps probing/i);
    assert.match(prompt, /Visual QA: not run/);
    assert.doesNotMatch(prompt, /--disable-sandbox/);
    assert.doesNotMatch(prompt, /--yolo/);
  } finally {
    if (saved !== undefined) process.env.MUSE_HEADLESS_SHELL_BIN = saved;
  }
});

test("NOT-303: museDeveloper prompt names the pre-installed headless shell when injected", () => {
  const prompt = buildDeveloperPrompt({
    taskSnapshot,
    round: 1,
    deckId: "deck-1",
    worktreePath: "/wt",
    museDeveloper: true,
    museVisualQa: {
      usable: true,
      binary: "/opt/headless/chrome-headless-shell",
      args: ["--screenshot=<png>", "--window-size=1280,800"],
      reason: "pre-installed headless shell",
    },
  });
  assert.match(prompt, /\/opt\/headless\/chrome-headless-shell/);
  assert.match(prompt, /--screenshot=<png>/);
  assert.match(prompt, /Google Chrome\.app/);
});

// NOT-381: non-Muse runtimes attempt in-session browser verification instead of
// the old blanket no-browser assumption — the prompt carries the bounded probe,
// the real-app requirement, the default viewports, and the receipt format.
test("NOT-381: a non-Muse developer prompt carries the capable-runtime visual-QA section", () => {
  const prompt = buildDeveloperPrompt({ taskSnapshot, round: 1, deckId: "deck-1", worktreePath: "/wt" });
  assert.match(prompt, /## Visual QA \(in-session browser verification\)/);
  assert.match(prompt, /ONE bounded capability probe/);
  assert.match(prompt, /REAL backend and frontend/);
  assert.match(prompt, /1440x900/);
  assert.match(prompt, /390x800/);
  assert.match(prompt, /do not install browsers or packages/);
  assert.match(prompt, /do not retry the failed capability/);
  assert.match(prompt, /do not weaken any sandbox flag/);
  assert.match(prompt, /never commit it/);
  assert.doesNotMatch(prompt, /RegisterApplication/);
});

// NOT-381: the policy is runtime-aware — Muse (boolean or runtime id) keeps the
// NOT-303 preflight, Claude Code / Codex Local / Cursor Local get the attempt.
test("NOT-381: runtime policy keeps Muse behavior and gives capable runtimes the attempt", () => {
  const saved = process.env.MUSE_HEADLESS_SHELL_BIN;
  delete process.env.MUSE_HEADLESS_SHELL_BIN;
  try {
    for (const runtime of ["claude_code", "codex_local", "cursor_local"] as const) {
      const prompt = buildDeveloperPrompt({
        taskSnapshot,
        round: 1,
        deckId: "deck-1",
        worktreePath: "/wt",
        runtime,
      });
      assert.match(prompt, /## Visual QA \(in-session browser verification\)/, runtime);
      assert.match(prompt, /ONE bounded capability probe/, runtime);
      assert.doesNotMatch(prompt, /RegisterApplication/);
    }
    const museByRuntime = buildDeveloperPrompt({
      taskSnapshot,
      round: 1,
      deckId: "deck-1",
      worktreePath: "/wt",
      runtime: "muse_code",
    });
    assert.match(museByRuntime, /## Visual QA \(screenshots\)/);
    assert.match(museByRuntime, /RegisterApplication/);
    assert.match(museByRuntime, /Visual QA: not run/);
    const museByFlag = buildDeveloperPrompt({
      taskSnapshot,
      round: 1,
      deckId: "deck-1",
      worktreePath: "/wt",
      museDeveloper: true,
      runtime: "claude_code",
    });
    assert.match(museByFlag, /RegisterApplication/, "museDeveloper flag keeps the Muse preflight");
  } finally {
    if (saved !== undefined) process.env.MUSE_HEADLESS_SHELL_BIN = saved;
  }
});

test("NOT-303: reviewer prompt states a missing screenshot is never a pass", () => {
  const prompt = buildReviewerPrompt(reviewerBase);
  assert.match(prompt, /missing screenshot/i);
  assert.match(prompt, /visual QA not run/);
  assert.match(prompt, /do not read the absence as a pass/);
});

test("a deckless developer prompt still fails closed", () => {
  const prompt = buildDeveloperPrompt({ taskSnapshot, round: 1, deckId: null });
  assert.match(prompt, /misconfigured: Agent Deck is required but missing/);
});

// NOT-310: the conflict-repair directive renders the base, the branch, and the
// conflicting files first — the developer merges the base before any other work.
test("NOT-310: conflict repair directive renders base, branch, and files before the task", () => {
  const prompt = buildDeveloperPrompt({
    taskSnapshot,
    round: 3,
    conflictRepair: { baseBranch: "main", branch: "issue-9", files: ["a.ts", "b.ts"] },
  });
  assert.match(prompt, /## Merge conflict with main/);
  assert.ok(prompt.includes("`issue-9`"), "branch must be named");
  assert.ok(prompt.includes("`a.ts`") && prompt.includes("`b.ts`"), "files must be named");
  assert.ok(prompt.includes("git fetch origin main"), "must fetch the base");
  assert.ok(prompt.includes("git merge origin/main"), "must merge the base");
  assert.match(prompt, /never force-push/i);
  assert.match(prompt, /never rebase/i);
  assert.ok(
    prompt.indexOf("## Merge conflict") < prompt.indexOf("## Task"),
    "conflict section must precede the task"
  );
});

test("NOT-310: unknown conflicting files render the discover-from-merge instruction", () => {
  const prompt = buildDeveloperPrompt({
    taskSnapshot,
    round: 2,
    conflictRepair: { baseBranch: "main", branch: "issue-9", files: [] },
  });
  assert.match(prompt, /## Merge conflict with main/);
  assert.match(prompt, /conflicting files are unknown/);
});

test("NOT-310: no conflict directive produces byte-for-byte the same prompt as before", () => {
  const base = { taskSnapshot, round: 2 as const };
  const without = buildDeveloperPrompt(base);
  assert.doesNotMatch(without, /## Merge conflict/);
  assert.equal(buildDeveloperPrompt({ ...base, conflictRepair: undefined }), without);
  assert.equal(
    buildDeveloperPrompt({ ...base, conflictRepair: { baseBranch: "", branch: "", files: [] } }),
    without
  );
});

// NOT-314: the developer prompt lists operator criteria separately — the worker
// ships the probe + doc and never attempts the criterion itself.
test("NOT-314: developer prompt lists operator criteria with the do-not-attempt instruction", () => {
  const prompt = buildDeveloperPrompt({
    taskSnapshot,
    round: 1,
    operatorCriteria: [
      {
        text: "Operator can sign in with SSO and see the org dashboard [operator]",
        commands: ["`npm run probe:sso -- --env staging`"],
      },
    ],
  });
  assert.match(prompt, /## Operator verification required/);
  assert.match(prompt, /Do not attempt these; ship the ready-to-run probe and a doc, put the exact command in the PR body/);
  assert.match(prompt, /sign in with SSO/);
  assert.match(prompt, /npm run probe:sso -- --env staging/);
});

test("NOT-314: no operator criteria produces byte-for-byte the same developer prompt as before", () => {
  const base = { taskSnapshot, round: 2 as const };
  const without = buildDeveloperPrompt(base);
  assert.doesNotMatch(without, /## Operator verification/);
  assert.equal(buildDeveloperPrompt({ ...base, operatorCriteria: undefined }), without);
  assert.equal(buildDeveloperPrompt({ ...base, operatorCriteria: [] }), without);
});

test("NOT-314: operator repair note renders verbatim under its own heading before the task", () => {
  const note = "The probe 404s — its path moved; fix the script and the doc.";
  const prompt = buildDeveloperPrompt({ taskSnapshot, round: 2, operatorRepairNote: note });
  assert.match(prompt, /## Operator verification feedback/);
  assert.ok(prompt.includes(note), "note text must appear verbatim");
  assert.ok(
    prompt.indexOf("## Operator verification feedback") < prompt.indexOf("## Task"),
    "repair feedback must precede the task"
  );
  const without = buildDeveloperPrompt({ taskSnapshot, round: 2 });
  assert.doesNotMatch(without, /## Operator verification feedback/);
  assert.equal(buildDeveloperPrompt({ taskSnapshot, round: 2, operatorRepairNote: "  " }), without);
});

// NOT-314: the reviewer must not flag missing operator evidence — Dealer gates
// the merge — but the probe and doc must exist.
test("NOT-314: reviewer prompt states missing operator evidence is not a defect, probe and doc must exist", () => {
  const prompt = buildReviewerPrompt({
    ...reviewerBase,
    operatorCriteria: [
      {
        text: "Operator can complete a paid checkout [operator]",
        commands: ["`npm run probe:checkout -- --env staging`"],
      },
    ],
  });
  assert.match(prompt, /## Operator-gated criteria/);
  assert.match(prompt, /Missing operator evidence is NOT a defect/);
  assert.match(prompt, /never raise a blocking finding/);
  assert.match(prompt, /probe and doc/);
  assert.match(prompt, /A missing probe or doc IS a blocking finding/);
  assert.match(prompt, /paid checkout/);
  assert.match(prompt, /npm run probe:checkout/);
});

test("NOT-314: no operator criteria produces byte-for-byte the same reviewer prompt as before", () => {
  const without = buildReviewerPrompt(reviewerBase);
  assert.doesNotMatch(without, /Operator-gated criteria/);
  assert.equal(buildReviewerPrompt({ ...reviewerBase, operatorCriteria: undefined }), without);
  assert.equal(buildReviewerPrompt({ ...reviewerBase, operatorCriteria: [] }), without);
});

// NOT-315: dependencies arrive installed (coordinator-side `npm ci`); the sandbox has
// no network, so the worker must never try to install them itself.
test("NOT-315: developer prompt tells the worker dependencies are installed and not to run npm install", () => {
  for (const round of [1, 2]) {
    const prompt = buildDeveloperPrompt({ taskSnapshot, round });
    assert.match(prompt, /Dependencies are installed; do not run npm install \(no network\)\./);
  }
  const retry = buildDeveloperPrompt({ taskSnapshot, round: 1, retryReason: "Developer session failed or crashed." });
  assert.match(retry, /Dependencies are installed; do not run npm install \(no network\)\./);
});

// NOT-316: a Muse developer learns the sandbox limits from its prompt — the
// section is rendered from MUSE_SANDBOX_CAPABILITIES, not hand-written prose.
// Other runtimes are unchanged.
test("NOT-316: museDeveloper prompt contains the Environment limits section; other runtimes do not", async () => {
  const { MUSE_SANDBOX_CAPABILITIES } = await import("../runners/muse-code-args.js");
  const muse = buildDeveloperPrompt({ taskSnapshot, round: 1, museDeveloper: true });
  assert.match(muse, /## Environment limits/);
  assert.ok(
    muse.includes(`sandbox network: ${MUSE_SANDBOX_CAPABILITIES.sandboxNetwork}`),
    "section header names the sandbox-network value from the constant"
  );
  assert.ok(muse.includes(`Network: ${MUSE_SANDBOX_CAPABILITIES.network}`), "network limit comes from the constant");
  assert.match(muse, /listen.*EPERM/i);
  assert.match(muse, /Browser: no/);
  assert.match(muse, /Credentials\/Keychain: no/);
  assert.match(muse, /After one failed attempt.*stop and hand off; do not work around the sandbox\./);
  const other = buildDeveloperPrompt({ taskSnapshot, round: 1 });
  assert.doesNotMatch(other, /## Environment limits/);
  assert.doesNotMatch(other, /do not work around the sandbox/);
});

// NOT-316: tag semantics appear only when the AC text carries the tags, per
// tag, and only for Muse developers — an untagged ticket's prompt carries no
// tag section at all.
test("NOT-316: developer tag semantics render per tag only for a Muse developer with tagged ACs", () => {
  const taggedBoth = {
    ...taskSnapshot,
    acceptanceCriteria: "- [ ] [agent] Widget renders in the preview.\n- [ ] [ci] Extend the `verify` workflow for widgets.",
  };
  const museBoth = buildDeveloperPrompt({ taskSnapshot: taggedBoth, round: 1, museDeveloper: true });
  assert.match(museBoth, /## Acceptance-criterion tags/);
  assert.match(museBoth, /`\[agent\]`: verify yourself/);
  assert.match(museBoth, /`\[ci\]`: implement or extend the named CI job\/test and push/);
  assert.match(museBoth, /CI is the evidence, do not reproduce it locally/);

  const agentOnly = buildDeveloperPrompt({
    taskSnapshot: { ...taskSnapshot, acceptanceCriteria: "- [ ] [agent] Widget renders." },
    round: 1,
    museDeveloper: true,
  });
  assert.match(agentOnly, /`\[agent\]`: verify yourself/);
  assert.doesNotMatch(agentOnly, /`\[ci\]`: implement or extend/);

  const ciOnly = buildDeveloperPrompt({
    taskSnapshot: { ...taskSnapshot, acceptanceCriteria: "- [ ] [ci] Extend the `verify` workflow." },
    round: 1,
    museDeveloper: true,
  });
  assert.match(ciOnly, /`\[ci\]`: implement or extend the named CI job\/test and push/);
  assert.doesNotMatch(ciOnly, /`\[agent\]`: verify yourself/);

  // Untagged Muse prompt: no tag section — snapshot-style byte check that the
  // tag feature adds nothing beyond the section itself.
  const untaggedMuse = buildDeveloperPrompt({ taskSnapshot, round: 1, museDeveloper: true });
  assert.doesNotMatch(untaggedMuse, /## Acceptance-criterion tags/);
  assert.doesNotMatch(untaggedMuse, /`\[agent\]`: verify yourself/);
  assert.doesNotMatch(untaggedMuse, /`\[ci\]`: implement or extend/);
  assert.equal(buildDeveloperPrompt({ taskSnapshot, round: 1, museDeveloper: true }), untaggedMuse);

  // Non-Muse prompts never carry tag semantics, even with tagged ACs.
  const otherTagged = buildDeveloperPrompt({ taskSnapshot: taggedBoth, round: 1 });
  assert.doesNotMatch(otherTagged, /## Acceptance-criterion tags/);
  assert.doesNotMatch(otherTagged, /## Environment limits/);
});

// NOT-316: the reviewer judges [ci] by the PR check status and never flags a
// missing [operator] result as a defect.
test("NOT-316: reviewer prompt judges [ci] by check status and never defects [operator]", () => {
  const tagged = buildReviewerPrompt({
    ...reviewerBase,
    taskSnapshot: {
      ...taskSnapshot,
      acceptanceCriteria: "- [ ] [ci] The `verify` workflow covers widgets.\n- [ ] [operator] Operator completes a paid checkout.",
    },
  });
  assert.match(tagged, /## Criterion tags/);
  assert.match(tagged, /Judge `\[ci\]` criteria by the PR check status in the evidence/);
  assert.match(tagged, /not by local runs/);
  assert.match(tagged, /Do not mark an `\[operator\]` criterion as a defect/);
  assert.match(tagged, /gated by Dealer/);
});

test("NOT-316: untagged reviewer prompt carries no tag-judging section", () => {
  const without = buildReviewerPrompt(reviewerBase);
  assert.doesNotMatch(without, /## Criterion tags/);
  assert.equal(buildReviewerPrompt(reviewerBase), without);
});

// NOT-364: the frozen attachment manifest renders in the developer prompt as
// local file paths plus link metadata with the trust boundary — and stays out
// entirely when the manifest is empty.
test("NOT-364: developer prompt lists frozen attachment files and links", () => {
  const withManifest = buildDeveloperPrompt({
    taskSnapshot: {
      ...taskSnapshot,
      sourceAttachments: [
        {
          linearAttachmentId: "att-file-1",
          kind: "file",
          title: "repro.tar.gz",
          safeFileName: "repro.tar.gz",
          blobPath: "/blobs/repro.tar.gz",
          sizeBytes: 18,
          sha256: "ab".repeat(32),
          url: "https://uploads.linear.app/a/repro.tar.gz",
        },
        {
          linearAttachmentId: "att-link-1",
          kind: "link",
          title: "Design doc",
          url: "https://docs.example.com/x",
        },
      ],
    },
    round: 1,
  });
  assert.match(withManifest, /## Source attachments \(untrusted ticket inputs/);
  assert.match(withManifest, /`\.agent-dealer-inputs\/linear\/repro\.tar\.gz`/);
  assert.match(withManifest, /link: "Design doc" — https:\/\/docs\.example\.com\/x/);
  assert.match(withManifest, /never commit them/);
  assert.match(withManifest, /never extract archives outside a fresh contained directory/);
  // Repair rounds see the same frozen section.
  const repair = buildDeveloperPrompt({
    taskSnapshot: {
      ...taskSnapshot,
      sourceAttachments: [
        {
          linearAttachmentId: "att-file-1",
          kind: "file",
          title: "repro.tar.gz",
          safeFileName: "repro.tar.gz",
          blobPath: "/blobs/repro.tar.gz",
          sizeBytes: 18,
          sha256: "ab".repeat(32),
          url: "https://uploads.linear.app/a/repro.tar.gz",
        },
      ],
    },
    round: 2,
  });
  assert.match(repair, /`\.agent-dealer-inputs\/linear\/repro\.tar\.gz`/);
});

test("NOT-364: attachment-free developer prompts render no source-attachment section", () => {
  const without = buildDeveloperPrompt({ taskSnapshot, round: 1 });
  assert.doesNotMatch(without, /## Source attachments/);
  assert.equal(buildDeveloperPrompt({ taskSnapshot, round: 1 }), without);
});

// NOT-381: the reviewer input carries the coordinator-validated visual receipt
// SHA-bound to the pinned head; unavailable is a routing state, never a pass.
test("NOT-381: reviewer prompt includes the validated visual receipt bound to the pinned head", () => {
  const headSha = "b".repeat(40);
  const prompt = buildReviewerPrompt({
    ...reviewerBase,
    visualQa: {
      pinnedHeadSha: headSha,
      record: {
        kind: "receipt",
        createdAt: "2026-10-08T00:00:00.000Z",
        content: {
          status: "verified",
          headSha,
          realApp: "real (no mocks)",
          scenario: "/widgets/new — fill the form and submit",
          viewports: ["1440x900", "390x800"],
          commands: "npm run dev; capture",
          screenshots: [
            { fileName: "0-desktop.png", blobPath: "/blobs/0-desktop.png", sizeBytes: 10, sha256: "ab".repeat(32) },
          ],
          capability: null,
          note: null,
          recordedAt: "2026-10-08T00:00:00.000Z",
        },
      },
    },
  });
  assert.match(prompt, /## Visual QA \(developer receipt — SHA-bound to this head\)/);
  assert.match(prompt, new RegExp(headSha));
  assert.match(prompt, /real \(no mocks\)/);
  assert.match(prompt, /0-desktop\.png/);
});

test("NOT-381: reviewer prompt presents unavailable and not-required receipts without normalizing to a pass", () => {
  const unavailable = buildReviewerPrompt({
    ...reviewerBase,
    visualQa: {
      pinnedHeadSha: reviewerBase.headSha,
      record: {
        kind: "receipt",
        createdAt: "2026-10-08T00:00:00.000Z",
        content: {
          status: "unavailable",
          headSha: reviewerBase.headSha,
          realApp: null,
          scenario: null,
          viewports: [],
          commands: null,
          screenshots: [],
          capability: "loopback listen: EPERM",
          note: null,
          recordedAt: "2026-10-08T00:00:00.000Z",
        },
      },
    },
  });
  assert.match(unavailable, /## Visual QA \(UNAVAILABLE — not verified\)/);
  assert.match(unavailable, /loopback listen: EPERM/);
  assert.match(unavailable, /never a pass/);
  assert.doesNotMatch(unavailable, /SHA-bound to this head/);

  const notRequired = buildReviewerPrompt({
    ...reviewerBase,
    visualQa: {
      pinnedHeadSha: reviewerBase.headSha,
      record: {
        kind: "receipt",
        createdAt: "2026-10-08T00:00:00.000Z",
        content: {
          status: "not_required",
          headSha: null,
          realApp: null,
          scenario: null,
          viewports: [],
          commands: null,
          screenshots: [],
          capability: null,
          note: null,
          recordedAt: "2026-10-08T00:00:00.000Z",
        },
      },
    },
  });
  assert.match(notRequired, /## Visual QA \(not required/);
  assert.doesNotMatch(notRequired, /SHA-bound to this head/);

  const without = buildReviewerPrompt(reviewerBase);
  assert.doesNotMatch(without, /## Visual QA \(developer receipt/);
  assert.doesNotMatch(without, /## Visual QA \(UNAVAILABLE/);
  assert.equal(buildReviewerPrompt({ ...reviewerBase, visualQa: undefined }), without);
  assert.equal(buildReviewerPrompt({ ...reviewerBase, visualQa: null }), without);
});

// NOT-364: reviewers get the immutable manifest as metadata only — no
// worktree path, no server blob path, no file contents.
test("NOT-364: reviewer prompt carries manifest metadata without file paths", () => {
  const prompt = buildReviewerPrompt({
    ...reviewerBase,
    taskSnapshot: {
      ...taskSnapshot,
      sourceAttachments: [
        {
          linearAttachmentId: "att-file-1",
          kind: "file",
          title: "repro.tar.gz",
          safeFileName: "repro.tar.gz",
          blobPath: "/blobs/repro.tar.gz",
          sizeBytes: 18,
          sha256: "ab".repeat(32),
          url: "https://uploads.linear.app/a/repro.tar.gz",
        },
        {
          linearAttachmentId: "att-link-1",
          kind: "link",
          title: "Design doc",
          url: "https://docs.example.com/x",
        },
      ],
    },
  });
  assert.match(prompt, /## Source attachments \(frozen manifest — metadata only/);
  assert.match(prompt, /"repro\.tar\.gz"/);
  assert.doesNotMatch(prompt, /\.agent-dealer-inputs/);
  assert.doesNotMatch(prompt, /\/blobs\//);
  const without = buildReviewerPrompt(reviewerBase);
  assert.doesNotMatch(without, /## Source attachments/);
});
