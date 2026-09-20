# Muse Code PoC results (NOT-183, epic NOT-164)

Protocol: [`README.md`](./README.md). Tasks: [`tasks.json`](./tasks.json). Nothing in the tasks or thresholds was changed after the first run.

## Privacy acceptance (recorded before the first candidate run)

The operator (Yusuke Muraoka) accepted that prompts and completions from these runs may be used to improve Meta products. Recorded from the operator's message in the session that ran this PoC, on 2026-09-20: "ok, you run it, make sure you'll use contributor model, not normal model, I am interested in using only contributor models". Terms: the catalog description for `muse-spark-1.3-contributor` ("Your content, including inter-session messages, may be used for product improvement."). All 5 tasks are marked `non_sensitive` in `tasks.json`.

## Subjects and versions

| | Value |
|---|---|
| Candidate | Muse Code 1.3.0 (1.3.0-R3401.1), `MUSE_NO_AUTO_UPDATE=1`, `--model muse-spark-1.3-contributor`, default reasoning effort (high) |
| Baseline | `claude -p`, `--model claude-sonnet-5 --effort high`, Claude Code 2.1.278 |
| Muse plan | Not observable (NOT-177 blocker `plan_identifier_observability`); the `-contributor` model id is the only tier signal |

A candidate run counts only if every `model_completed.model` in its session log is `muse-spark-1.3-contributor`.

## Runs

10 runs (5 tasks x 2 arms), one valid run each; none was infrastructure-invalid, so there were no reruns. Arm order alternated by task index (muse-01, 04, 07 candidate first; muse-02, 05 baseline first). Verification = the held-out tests from each shipped PR, exit 0 and `fail 0`. Times are spawn to exit; no run timed out.

| Task | Baseline (Claude) | Candidate (Muse) | Baseline wall | Candidate wall | Muse / Claude |
|---|---|---|---|---|---|
| muse-01 | **pass** (17/17) | **pass** (17/17) | 31 s | 57 s | 1.8x |
| muse-02 | fail (11/12) | fail (11/12) | 54 s | 167 s | 3.1x |
| muse-04 | fail (91/92) | fail (91/92) | 222 s | 46.9 min | 12.7x |
| muse-05 | fail (85/86) | **pass** (86/86) | 17.4 min | 182 s | 0.2x |
| muse-07 | **pass** (21/21) | **pass** (21/21) | 73 s | 257 s | 3.5x |

Verified completions: **baseline 2/5, candidate 3/5**. Median wall time: baseline 73.1 s, candidate 182.5 s (**2.50x**).

Usage (raw result events / session logs, not Dealer's `usage_events`):

| Task | Claude cost | Claude output tokens | Muse input tokens | Muse output tokens |
|---|---|---|---|---|
| muse-01 | $0.09 | 2,301 | 304,451 (259,261 cached) | 2,958 |
| muse-02 | $0.13 | 3,929 | 926,474 (865,485 cached) | 9,299 |
| muse-04 | $0.42 | 12,688 | 4,953,650 (4,844,359 cached) | 30,190 |
| muse-05 | $0.26 | 8,641 | 2,095,386 (1,962,197 cached) | 14,331 |
| muse-07 | $0.23 | 5,743 | 985,781 (932,135 cached) | 12,777 |

Claude total cost for the 5 runs: $1.13 (`total_cost_usd`). Muse total: 9,265,742 input tokens (8,863,437 cached), 69,555 output; **no cost, credit or quota field exists in any Muse output** (NOT-177), so its cost is `null`.

## Threshold verdicts

| # | Threshold | Result | Verdict |
|---|---|---|---|
| 1 | Completion: `V_candidate >= V_baseline - 1` | 3 >= 2 - 1 | **pass** |
| 2 | Time: `median(w_candidate) <= 2 x median(w_baseline)` | 182.5 s vs 2 x 73.1 s = 146.2 s (2.50x) | **fail** |
| 3 | Cost: `K_candidate < K_baseline` | candidate cost is `null` (no cost/quota data, no published per-token rate observed) | **incomparable** |

Go needs thresholds 1 and 2 to pass, so this is **not a go**.

## Decision

**Retry later.** Do not build the adapter (NOT-178, NOT-179, NOT-181) now. This is the run operator's recommendation; the owner confirms or changes it when reviewing this file.

Why not a flat no-go: correctness held up (3/5 against 2/5; the two arms failed the same tests on muse-02 and muse-04, below), no run used cron, and contributor-only was enforced on every candidate run. The failure is time, and the cost half of the question could not be answered at all.

Retry when 1 or 2 changes (3 is a precondition for any unattended use either way):
1. Muse exposes usage cost, credits or quota, or Meta publishes a per-token rate for `muse-spark-1.3`, so threshold 3 becomes comparable. Without it the budget hypothesis (NOT-164) cannot be tested.
2. A Muse release or model that brings the time ratio under 2x. muse-04 took 47 minutes and read 4,953,650 input tokens (97.8% cached) against 3.7 minutes for Claude. Muse was faster on muse-05 (0.2x) and slower on the other four (1.8x to 12.7x).
3. Precondition, not a trigger: the NOT-177 blockers are resolved (`cron_tool_disable`, `mcp_tool_allowlist_enforcement`) before any unattended use; that is required for the adapter regardless of this result.

## What the numbers can and cannot show

- **Five tasks, one run each.** A single slow or lucky run moves a median. Treat the time verdict as indicative. It does not hinge on the muse-04 outlier: without muse-04 the medians are 63.7 s (baseline) against 174.8 s (candidate), 2.74x.
- **muse-02 and muse-04: both arms failed the same single held-out test.** They tie on the completion count, so they say nothing about which model is better.
  - muse-04: both arms missed a stated requirement. The spec says an exit-0 dirty escalation's reason becomes `<base> Recovery:` plus the recovery commands, and the held-out test asserts `/Recovery:/`. This is a shared model miss, not a spec gap.
  - muse-02: the spec is under-specified. It names `assertReviewerReadOnly`, but the failing assertion (`permissions.test.ts:95`) is on its sibling `isReviewerReadOnly(args, ctx)`, which the spec never mentions. Both arms added the context to the asserting function only.
  Both stay in the tally because the protocol forbids changing tasks after the first run.
- **muse-05:** Claude failed one test that took 158 s; Muse passed all 86. That is a genuine difference on this run.
- **Cost is unresolved, not unfavourable.** Claude's list-rate cost was $1.13 for the 5 runs. The contributor tier's cost to the operator is not observable, so no saving is claimed. The README asked for rate sources and retrieval dates to be recorded before run 1; that was not done because the candidate cost is `null` either way, so the cost threshold is `incomparable` regardless.

## Deviations and caveats

- **History-free export.** Each run used `git archive` of `startingSha` in a fresh single-commit repository, not a detached checkout of a clone, and the held-out tests were read from `referenceSha` by the harness. This removes the reference commits from the worker's reach and is stricter than the README's contamination rule. It is identical for both arms. No transcript contained the reference SHA, `docs/evaluations/muse-code`, or a GitHub URL.
- **Sandboxing is not symmetric.** Muse ran with its OS sandbox on and restricted network. The Claude arm used Claude Code's default Bash tool, whose network and process access are unrestricted.
- **Supervision was per-run review after the fact, not live.** No Muse transcript contains `cron_create` or any `cron_` call. Outside the worktree, Muse wrote only its own session files and one scratch script (`/tmp/salvage-e2e.mjs`, muse-04). The sandbox permits writes to `/tmp`.
- **Prompt.** Both arms got the same rendered prompt: the task title, description and acceptance criteria, then "commit, do not push, run relevant tests, end with a summary". It is not Dealer's production prompt.
- **Muse step cap** was set to 300 model steps; no run reached it, and the wall-clock timeout is the real limit for both arms.
- **Invocation.** Muse: `MUSE_NO_AUTO_UPDATE=1 muse exec --json --no-foreign-personal-context --model muse-spark-1.3-contributor --approval-mode never --approval-judge off --sandbox-network restricted --disable-web-tools --session-id <uuid> --max-model-steps 300 "<prompt>"`, with the NOT-177 settings template minus the MCP server (workflows, subagents and reminder plugins off), per-run `XDG_CONFIG_HOME`/`XDG_DATA_HOME`, and a symlinked `auth.json`. Claude: `claude -p "<prompt>" --model claude-sonnet-5 --effort high --setting-sources project --strict-mcp-config --mcp-config '{"mcpServers":{}}' --tools Read,Write,Edit,Glob,Grep,Bash --permission-mode dontAsk --output-format stream-json --verbose`. `--setting-sources project` keeps the operator's global Agent Deck instructions out of the baseline.
- **Model confirmation.** For all 5 candidate runs, every `model_completed.model` in the session log was `muse-spark-1.3-contributor`. All 5 baseline runs reported `claude-sonnet-5` in the init event.
- Raw transcripts, session logs and the harness are not committed; they hold machine paths. The harness and results directory are in the operator's scratch space and can be shared on request.
