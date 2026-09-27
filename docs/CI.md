# CI

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

AC4 is only closed by an actually-run verbatim transcript pasted into the PR
description, not by this procedure text. This repair-round session has no shell
access (all shell commands are policy-denied), so no transcript can be produced
or verified from here — repeated coding passes cannot close AC4. To close the
finding, a human (or shell-enabled session) must run the one-liner above at
HEAD `857f6b1` on a machine with a real developer `~/.claude.json` present,
then paste the verbatim output plus the `exit=` line into the PR description
inside the block below. If a live replay is impossible (e.g. no machine with
`~/.claude.json` handy), a human must record an explicit waiver in the PR
instead — the agent cannot waive AC4 on its own authority.

```text
# AC4 NOT-268 replay transcript (pending — replace this block with verbatim output):
# $ git rev-parse HEAD
# 857f6b1...
# $ ls ~/.claude.json
# /Users/<you>/.claude.json
# $ BASELINE_REF=v1.2.2 bash scripts/verify-baseline-failures.sh packages/server/src/routes/runtime-capacity.test.ts; echo "exit=$?"
# <paste verbatim script output here — must show non-zero exit, the failing
#  test name ("GET /api/runtime-capacity returns normalized entries without
#  evidence"), HEAD 857f6b1 and the v1.2.2 baseline>
# exit=1
```

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
