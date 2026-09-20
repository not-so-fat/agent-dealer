# Muse Code PoC protocol (NOT-176, epic NOT-164)

A small go/no-go screen for one question:

> Can **native Muse Code on the Muse contributor tier** do Agent Dealer developer work well enough, and cheaply enough, to justify building an adapter?

The protocol and [`tasks.json`](./tasks.json) are fixed **before** any run. Changing a task, threshold or subject after the first run invalidates the affected runs. It is not a full benchmark: 5 tasks, one developer role, 3 thresholds. Muse Spark through Codex is not the candidate. The adapter (NOT-178, NOT-179, NOT-181) is only built if NOT-183 decides "go".

## Subjects

Each subject is frozen to an explicit runtime, model id, effort, CLI version and invocation; nothing resolves from a CLI default during the run. `scripts/validate-muse-code-manifest.mjs` rejects nulls and descriptive values.

| | Runtime | Model | Effort | CLI |
|---|---|---|---|---|
| **Baseline** (`Claude Dev`, the production developer profile) | `claude_code` | `claude-sonnet-5` (`--model`) | `high` (`--effort`) | Claude Code 2.1.278 |
| **Candidate** | `muse_code` (native Muse Code CLI, contributor tier) | `muse-spark-1.3-contributor` (`--model`) | `high` (Muse default, not varied) | Muse Code 1.3.0 (1.3.0-R3401.1), `MUSE_NO_AUTO_UPDATE=1` |

The baseline profile leaves model and effort unset, so the CLI resolves them; on 2026-09-19 that gives `claude-sonnet-5` and `high`. The evaluation uses an eval copy of the profile with both set explicitly. A baseline run whose stream init event reports a different model is infrastructure-invalid.

The candidate id is the one pinned by NOT-177. Muse accepts an unknown `--model` and still exits 0, so a candidate run counts only if the session log's `model_completed.model` equals `muse-spark-1.3-contributor`; otherwise it is infrastructure-invalid.

## Privacy

Contributor-tier prompts and completions **may be used to improve Meta products.**

1. The operator records the acceptance in `poc-results.md` before the first candidate run. No record, no candidate run.
2. Only tasks marked `sensitivity.classification: "non_sensitive"` run on the tier. All 5 are historical changes to the public repository `github.com/not-so-fat/agent-dealer` at a pinned commit. Anything added later must be classified first.
3. Neither arm gets MCP servers, an Agent Deck, or credentials in its environment.

## Run rules

Per task, both arms share the identical worker spec, `startingSha` (detached checkout of the same commit), `timeoutSeconds` (small 1200, medium 2400) and verification commands. One valid run per task per arm (10 runs). Arm order alternates by task index.

- **Fresh worktree** at `startingSha` for every run. Muse runs with the sandbox on, approvals off, never `--yolo`, no MCP (the safe developer posture from NOT-177). A supervised run is required: NOT-177 found that Muse cannot disable `cron_*`.
- **Held-out tests.** Verification copies the test files from `referenceSha` into the worktree after the run, replacing anything the worker wrote there. The worker spec therefore states the interface the tests depend on. Each command was checked to fail at `startingSha` and pass at `referenceSha`:

  | Task | at startingSha | at referenceSha |
  |---|---|---|
  | muse-01 | exit 1 (1 fail) | pass 17 |
  | muse-02 | exit 1 (2 fail) | pass 12 |
  | muse-04 | exit 1 (32 fail) | pass 92 |
  | muse-05 | exit 1 (4 fail) | pass 86 |
  | muse-07 | exit 1 (1 fail) | pass 21 |

- **Contamination.** A run whose transcript reads `referenceSha` content (for example `git show <referenceSha>`) or `docs/evaluations/muse-code` is scored as failed, in both arms. The clone's history contains the reference commits.
- **Verified completion.** Every verification command exits with its `expectedExitCode` and matches `expectedResult`, capped at 600 s (a hang is a failure). The worker's own exit code and its final message decide nothing.
- **Infrastructure-invalid vs valid.** Invalid means provably not the model's fault: harness crash, network or auth failure, CLI failing before its first model turn, account usage cap. Rerun only these, once, and keep every attempt in the results. Timeouts, wrong output, giving up and tool misuse are valid runs and count against the arm.
- **Interventions.** Any operator action after launch that changes a run's course is counted and reported. It is reported, not gated.

## Cost

One frozen basis for both arms: **list-rate shadow cost**, i.e. token usage priced at the vendor's published per-token rates for the frozen model, whatever plan each arm actually pays. Record the rate source URL and retrieval date per model in `poc-results.md` before run 1.

Providers report cached tokens either inside or outside their input total, so raw fields are never summed. Cost uses four disjoint quantities: `cost = uncached_input × r_input + cache_read × r_cache_read + cache_write × r_cache_write + output × r_output`. `tasks.json` maps each runtime's raw usage fields to them (Claude: `input_tokens` already excludes cache; Codex-style totals subtract the cached subset). Costing reads the raw result event, not Dealer's `usage_events`, which lacks cache tokens.

Missing token or cost data is `null`, never 0, and never a saving. Attributable cost `K` is the sum over an arm's 5 valid runs **plus** any paid infrastructure-invalid attempts (real spend). `K` is `null` if any term is `null`. If Meta publishes no per-token rate for the model, or Muse reports no token counts, the candidate's cost is `null`. Report each arm's actual plan and price separately; a contributor-tier price of $0 is payment in data, not a like-for-like cost, and cannot satisfy the cost threshold.

## Thresholds

`V_x` is the number of verified completions of the 5 tasks, `w_i` the wall time of a run in seconds (spawn to exit or kill; a timed-out run counts as `timeoutSeconds`), and `K_x` as above.

| # | Threshold | Formula |
|---|---|---|
| 1 | Completion | `V_candidate ≥ V_baseline − 1` |
| 2 | Time | `median(w_i, candidate) ≤ 2 × median(w_i, baseline)` |
| 3 | Cost | `K_candidate < K_baseline`; `incomparable` if either is `null` |

Each threshold is reported as pass, fail or incomparable. **Go** needs thresholds 1 and 2 to pass and threshold 3 to pass or be incomparable with a written note; anything else is no-go or retry-later, decided in NOT-183.

## Validating the manifest

```bash
node scripts/validate-muse-code-manifest.mjs   # shape, frozen subjects, coverage, pinned commits, held-out paths
node --test scripts/validate-muse-code-manifest.test.mjs
git diff --check
```

The validator needs the full commit history. It checks: parseable JSON; both subjects freeze a non-null runtime, model id, effort, CLI version and an invocation that passes the model; a frozen `costModel`; exactly 5 tasks with every required field (`id`, `sourceIssue`, `repository`, `startingSha`, `referenceSha`, `workerSpec`, `role`, `category`, `sizeClass`, `sensitivity`, verification commands with `expectedExitCode` and `expectedResult`); coverage minimums (at least 3 implementation, 1 test/debug, 1 medium or long); that both SHAs resolve to real commits with `startingSha` an ancestor of `referenceSha`; and that each held-out path exists at `referenceSha` and is run by a verification command.

## Amendments

- **2026-09-20 (NOT-187): muse-02 spec.** The worker spec named `assertReviewerReadOnly` but not its sibling `isReviewerReadOnly`, which the held-out test calls with the context. The spec and acceptance criteria now name it. The amendment applies to retries only. `poc-results.md` was produced with the original spec, is unchanged, and both arms failed that one test; the original wording is in git history (`ec8c118`).
