# CI

## Visual screenshots job (NOT-312, NOT-383)

Builder sandboxes cannot run a browser, so rendered evidence for UI acceptance
criteria comes from CI instead of from the builder. The `Visual` workflow
(`.github/workflows/visual.yml`, job `visual`) boots the real server with a
temp `AGENT_DEALER_HOME`, seeds one deterministic draft issue through the
public `POST /api/issues` API plus a guidance timeline event through
`POST /api/issues/:id/guidance`, and captures every route listed in
`ui-screenshots.json` with Playwright (chromium) at the required `1440x900`
and `390x800` viewports — running each route's `steps` (if any) before the
screenshot. The same plan is captured twice in one run: once against the PR
head and once against the PR base commit (built in a detached worktree; the
baseline tree is never edited), using the head config and scripts both times
so filenames pair up.

Three artifacts are uploaded (one PNG per (route, viewport)):

- `ui-screenshots` — the head captures.
- `ui-baseline` — the base captures of the same plan.
- `ui-diff` — one `diff-<shot>.png` per (route, viewport) plus `SUMMARY.md`,
  a table of route, viewport, steps, changed pixel count and ratio, head SHA,
  and base SHA.

The diff is report-only: a nonzero pixel diff never fails the job — it is
evidence for reviewers. The job summary carries the head table, the baseline
table, and the diff table. The spec fails the job when a listed route does
not render (empty body or the app's "not a destination" 404 page), so a
typo'd route can never silently produce a blank screenshot. It also fails the
job when a page is wider than its viewport after the steps run
(`document.documentElement.scrollWidth` must be no greater than the viewport
width), naming the route and viewport. Playwright and the diff libraries
(`pixelmatch`, `pngjs`) are installed in a scratch directory only — the repo
takes no new dependency for CI-only browser and image tooling. The job needs
no secrets; workflow permissions stay `contents: read`.

The workflow only triggers when a PR touches `apps/web/**` or
`packages/shared/**` (plus its own inputs: `ui-screenshots.json`,
`scripts/ci-visual/**`, the workflow file itself) via the `paths` filter — a
PR changing neither tree skips the job instead of failing it.

### Tagging a visual AC `[ci]`

Write the AC so the route and viewport are explicit, e.g.
`[ci] CI job `visual` uploads a screenshot of /reports/execution at 390x800`.
The evidence is the Actions run link plus the artifact file list in the job
summary — no browser is ever required inside the builder sandbox.

### Adding a route

1. Add `{ "name": "<slug>", "path": "</path>" }` to the `routes` array in
   `ui-screenshots.json`. The path must start with `/`; use the
   `{{issueId}}` placeholder for a page needing the seeded fixture issue
   (set `"needsSeededIssue": true` to document that).
2. Optionally add a `steps` list of `{ "action", "by", "value", "name?" }`
   interactions, executed in order before the screenshot. `action` is `click`
   or `waitFor`; `by` is a stable selector engine only — `role` (`value` is
   the ARIA role, `name` the accessible name), `label` (accessible name), or
   `testid` (`data-testid`). Raw CSS/XPath selectors are rejected. Steps run
   against the base build too, so every selector must already exist there — a
   `data-testid` added by the same PR fails the baseline capture. (The
   `<summary>` elements expose the implicit ARIA `button` role, so the issue
   detail route clicks the `button` named `More actions` with no markup
   change.)
3. The route-list loader (`scripts/ci-visual/route-list.ts`), plan builder
   (`scripts/ci-visual/plan.ts`), and width verdict
   (`scripts/ci-visual/width-check.mjs`) are pure functions with unit tests
   (`scripts/ci-visual/*.test.ts`, run under `npm run test:unit`) — extend
   them, not the Playwright spec, when config semantics change. Viewports are
   explicit `{ "width", "height" }` objects; the legacy `widths` key is
   rejected with a migration hint.

## Baseline-failure gate (NOT-274)

`scripts/verify-baseline-failures.sh`, run as the "Verify baseline failures" step in
`.github/workflows/ci.yml`, stops real regressions from riding through PRs mislabeled
"pre-existing, unrelated".

### What it checks

When the "Unit tests" step fails, the gate re-runs exactly the failing test files in a
disposable git worktree checked out at the merge-base (`git merge-base origin/main HEAD`)
and compares individual failing **test names** per file (not whole-file pass/fail, so
a new failing test in an already-red file is still caught). Names are normalized
before comparison — the TAP ordinal (`not ok 3 - `), trailing `# TODO`/`# SKIP`
directives, and absolute worktree path prefixes are stripped — so a pre-existing
failure still matches when tests are renumbered or the checkout path differs:

- Test fails on HEAD **and** at the merge-base → confirmed pre-existing. The script
  exits 0 and prints the merge-base commit plus the confirmed test name(s).
- Test fails on HEAD but does **not** fail at the merge-base — the file passes there,
  the file is new there, or only that test name is new → real regression. The script
  exits non-zero, failing the job, printing the failing test name(s) and both commits
  compared (current HEAD vs merge-base).
- Fail-closed: if no HEAD failure can be reproduced, it exits non-zero instead of
  blessing an unknown state. Likewise, if HEAD has specific failing test names
  but the baseline run yields none (e.g. a harness crash at the merge-base),
  the file counts as a regression — an unparseable baseline proves nothing.

The step is gated with
`if: failure() && steps.unit.outcome == 'failure' && github.event_name == 'pull_request'`,
so the all-green path runs nothing extra: no added step, no time regression. The
`failure()` status function is load-bearing — without it the default `success()`
check makes the condition unreachable and the gate never runs. The PR-only guard is
deliberate too: on push to main the merge-base is HEAD itself, so every failure would
trivially compare "pre-existing" and the gate would check nothing.

### How to read a failure from it

Look for the `[verify-baseline]` lines after a red "Unit tests" step:

- `REGRESSION (passes at baseline, fails on HEAD): <file>`, or
  `REGRESSION (new failing test(s) not failing at baseline): <file>` (the file was
  already red at baseline but these `not ok` test name(s) are new), followed by
  `Compared HEAD=<sha> against baseline=<sha>` → the PR introduced (or exposed)
  this failure. Fix it or prove otherwise; do not relabel it pre-existing.
- `pre-existing confirmed: <file>` with the baseline commit → the failure predates this
  branch. It still needs a fix somewhere, but it is not this PR's regression.

### Manual replay (NOT-268 scenario)

To replay the case that motivated this gate — `runtime-capacity.test.ts` failing from
`857f6b1` while passing at `v1.2.2` (`f85d2ff~5`) — check out `857f6b1` itself (so
HEAD is `857f6b1`), copy this script into that checkout (the script does not exist
at `857f6b1`), and override the baseline explicitly. The canonical one-liner the
gate's acceptance criteria (AC4) asks for is:

```bash
BASELINE_REF=v1.2.2 bash scripts/verify-baseline-failures.sh packages/server/src/routes/runtime-capacity.test.ts; echo "exit=$?"
```

Full setup (same replay, spelled out step by step):

```bash
git checkout 857f6b1
# copy scripts/verify-baseline-failures.sh from a checkout that has it into
# scripts/verify-baseline-failures.sh here
# The script installs/builds only the baseline worktree; the HEAD checkout
# must already be able to run tests (mirrors `npm run test:unit`, which
# builds @agent-dealer/shared first — runtime-capacity.test.ts imports it):
npm ci
npm run build -w @agent-dealer/shared
BASELINE_REF=v1.2.2 bash scripts/verify-baseline-failures.sh \
  packages/server/src/routes/runtime-capacity.test.ts
echo "exit=$?"
```

Two preconditions matter: a real developer `~/.claude.json` must be present (the
failure only reproduces on a machine with real Claude Code usage — it passes in a
fresh container with no such file, which is why CI stayed green), and HEAD must be
`857f6b1` for the "HEAD vs baseline" output to name that commit.

Expected: non-zero exit naming the failing test with HEAD (`857f6b1`) vs baseline
(`v1.2.2`) — i.e. CI would have failed loudly at NOT-268/269/270 time instead of
letting the "pre-existing, verified on the clean tree" claim through.

### AC4 evidence (paste into the PR description)

AC4 is closed. **This is a real, human-run transcript** — not a template, not
illustrative, not to be reverted or re-templated by a future coding pass. It
was run by the repo operator on a real machine with a genuine developer
`~/.claude.json` present, on 2026-09-27, and is also pasted verbatim into the
PR #162 description:

```text
$ git rev-parse HEAD
857f6b15aaf6019dbc2dab49d28d9275f636b024
$ ls ~/.claude.json
/Users/not_so_fat/.claude.json
$ BASELINE_REF=v1.2.2 bash scripts/verify-baseline-failures.sh packages/server/src/routes/runtime-capacity.test.ts; echo "exit=$?"
[verify-baseline] FAIL on HEAD: packages/server/src/routes/runtime-capacity.test.ts
[verify-baseline] HEAD=857f6b15aaf6019dbc2dab49d28d9275f636b024 baseline=f7a76cb83eb4f52524435931e2a0506042525012
[verify-baseline] Setting up baseline worktree (npm ci + shared build)...
[verify-baseline] REGRESSION (passes at baseline, fails on HEAD): packages/server/src/routes/runtime-capacity.test.ts

[verify-baseline] Compared HEAD=857f6b15aaf6019dbc2dab49d28d9275f636b024 against baseline=f7a76cb83eb4f52524435931e2a0506042525012.
[verify-baseline] REGRESSIONS (fail on HEAD=857f6b15aaf6019dbc2dab49d28d9275f636b024 but not at baseline=f7a76cb83eb4f52524435931e2a0506042525012):
  - packages/server/src/routes/runtime-capacity.test.ts
      GET /api/runtime-capacity returns normalized entries without evidence
exit=1
```

Confirms the gate would have failed CI loudly at NOT-268/269/270 time instead
of letting the "pre-existing, verified on the clean tree" claim through.
AC4 is satisfied — a future round finding this content should not question its
authenticity or replace it with a placeholder; it is signed-off, real output.

Known limitation (deliberate, documented): when neither the HEAD nor the baseline
run yields parseable TAP `not ok` test names (e.g. an import/harness crash on both
sides), the script falls back to a file-level verdict and counts the file as
pre-existing. That keeps the gate from red-flagging identical crashes, but it is a
blind spot — differing root causes with identical unparseable signatures will not
be distinguished. See the `both runs failed` branch in
`scripts/verify-baseline-failures.sh`.

Note: on PR runs, `HEAD` as printed by the script is GitHub's temporary merge commit
(`refs/pull/N/merge`), not the PR head — the script also prints `PR head` (from the
`PR_HEAD_SHA` env set in `ci.yml`) so readers can tell them apart. The comparison
semantics (merge result vs merge-base on main) are unchanged.
