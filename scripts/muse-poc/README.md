# Muse Code PoC run harness (NOT-183, NOT-187)

Re-runs the PoC in [`docs/evaluations/muse-code/README.md`](../../docs/evaluations/muse-code/README.md) against `tasks.json`: each task, both arms (native Muse Code on `muse-spark-1.3-contributor` vs Claude `claude-sonnet-5`). **`run` and `chain.sh` start paid model sessions and send prompts to Meta's contributor tier.** Record the operator's privacy acceptance in the results file first, as the protocol requires, and only re-run when a retry trigger in NOT-164 has fired.

Runs are supervised after the fact: read each Muse transcript for `cron_` calls and writes outside the worktree before trusting a result (Muse cannot disable `cron_*`, see NOT-177).

## Environment

| Variable | Meaning | Default |
|---|---|---|
| `MUSE_POC_REPO` | checkout containing `docs/evaluations/muse-code/tasks.json` | git toplevel of the current directory |
| `MUSE_POC_WORKDIR` | where runs are written (never commit it: it holds machine paths) | `$TMPDIR/muse-poc` |
| `MUSE_BIN` | Muse Code binary | `muse` on `PATH` |
| `CLAUDE_BIN` | Claude Code binary | `claude` on `PATH` |

Muse must be logged in (`~/.config/muse/auth.json` is symlinked into each run's isolated config, never read or copied) and pinned: the harness sets `MUSE_NO_AUTO_UPDATE=1`.

## Commands

```bash
python3 scripts/muse-poc/harness.py                                  # usage
python3 scripts/muse-poc/harness.py prepare TASK_ID                  # history-free export of startingSha + npm ci
python3 scripts/muse-poc/harness.py dry-verify TASK_ID               # starts no model; exit 0 = the untouched tree fails, as it must
python3 scripts/muse-poc/harness.py run TASK_ID muse                 # one arm of one task
python3 scripts/muse-poc/harness.py run TASK_ID claude
scripts/muse-poc/chain.sh                                            # every task, both arms, alternating order
```

`dry-verify` on `muse-01-incremental-commit-prompt` must report exit 1 with 16 of 17 tests passing. If a start tree verifies, the task tests nothing.

## What a run does

- Exports `startingSha` with `git archive` into a fresh single-commit repository (no reference commits reachable), runs `npm ci` once per task, and clones that tree per arm.
- Runs one arm with the same prompt, timeout (`timeoutSeconds`) and no MCP servers or deck. Muse: the NOT-177 recommended posture (sandbox on, approvals off, workflows, subagents and reminder plugins off). Claude: `--setting-sources project`, so global instructions do not leak in.
- Copies the held-out tests from `referenceSha` over the worktree and runs the task's verification command. Verified means exit 0 and `fail 0`.
- Writes `runs/<task>/<arm>/result.json`: wall time, exit code, verification, contamination hits, token usage and cost. A Muse run counts only if every `model_completed.model` is `muse-spark-1.3-contributor` (`model_ok`).

Not automated: reading transcripts, assembling the results table, and the go/no-go decision. Those go in a new results file.

## Trying Muse on a real task by hand

`muse-task.py` runs one prompt in a fresh git worktree, in the same safe posture (sandbox on, approvals off, no MCP, workflows, subagents and reminders off, contributor model pinned):

```bash
python3 scripts/muse-poc/muse-task.py "<task prompt>" [--repo DIR] [--base REF] [--timeout SECONDS] [--max-steps N]
```

It leaves the worktree on a new `muse/<timestamp>` branch and prints the exit code, wall time, the models the session log confirms (anything other than `muse-spark-1.3-contributor` means do not trust the run), token usage, whether any `cron_` tool was used, and the changed files. It never commits, pushes or merges. **It starts a paid contributor-tier session and sends the prompt to Meta: use it on non-sensitive work only**, and read the diff and transcript before trusting the result. It does not run `npm ci`; install dependencies in the worktree if the task needs to run tests. `MUSE_TASK_DIR` sets where runs are written (default `$TMPDIR/muse-task`).
