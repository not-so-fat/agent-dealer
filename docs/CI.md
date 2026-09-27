# CI

## Baseline-failure gate (NOT-274)

`scripts/verify-baseline-failures.sh`, run as the "Verify baseline failures" step in
`.github/workflows/ci.yml`, stops real regressions from riding through PRs mislabeled
"pre-existing, unrelated".

### What it checks

When the "Unit tests" step fails, the gate re-runs exactly the failing test files in a
disposable git worktree checked out at the merge-base (`git merge-base origin/main HEAD`)
and compares outcomes:

- File fails on HEAD **and** at the merge-base → confirmed pre-existing. The script
  exits 0 and prints the merge-base commit plus the confirmed test name(s).
- File fails on HEAD but **passes** at the merge-base (or is new there) → real
  regression. The script exits non-zero, failing the job, printing the failing test
  name and both commits compared (current HEAD vs merge-base).
- Fail-closed: if no HEAD failure can be reproduced, it exits non-zero instead of
  blessing an unknown state.

The step is gated with `if: steps.unit.outcome == 'failure'`, so the all-green
path runs nothing extra: no added step, no time regression.

### How to read a failure from it

Look for the `[verify-baseline]` lines after a red "Unit tests" step:

- `REGRESSION (passes at baseline, fails on HEAD): <file>` followed by the `not ok`
  test name(s) and `Compared HEAD=<sha> against baseline=<sha>` → the PR introduced
  (or exposed) this failure. Fix it or prove otherwise; do not relabel it pre-existing.
- `pre-existing confirmed: <file>` with the baseline commit → the failure predates this
  branch. It still needs a fix somewhere, but it is not this PR's regression.

### Manual replay (NOT-268 scenario)

To replay the case that motivated this gate — `runtime-capacity.test.ts` failing from
`857f6b1` while passing at `v1.2.2` (`f85d2ff~5`) — override the baseline explicitly:

```bash
BASELINE_REF=v1.2.2 bash scripts/verify-baseline-failures.sh \
  packages/server/src/routes/runtime-capacity.test.ts
```

Expected: non-zero exit naming the failing test with HEAD (`857f6b1`) vs baseline
(`v1.2.2`) — i.e. CI would have failed loudly at NOT-268/269/270 time instead of
letting the "pre-existing, verified on the clean tree" claim through. Paste this
output as verification evidence in the PR description.
