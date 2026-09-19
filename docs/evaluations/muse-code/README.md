# Muse Code evaluation contract (NOT-176, epic NOT-164)

Fixed, budget-first contract for one question:

> Can **native Muse Code on the Muse contributor tier** materially reduce Agent Dealer execution cost while keeping acceptable task quality and reliability?

This document and [`tasks.json`](./tasks.json) are written **before** any adapter exists or any result is available. Nothing here is tuned to results. Changing a task, threshold, formula or subject after the first run starts invalidates the affected runs.

**Non-goals:** configuring Muse through Codex (Muse Spark via Codex is not the candidate), implementing the `muse_code` adapter, running the bakeoff, or running any sensitive production work on the contributor tier.

## Subjects

| | Runtime | Model | Effort | Pricing basis |
|---|---|---|---|---|
| **Baseline developer** (`Claude Dev`) | `claude_code` | unset in the profile → Claude Code CLI default; exact id read from each run's init event | unset (no `--effort`) | `total_cost_usd` reported by Claude Code (API-equivalent estimate); tokens from `result.usage` |
| **Baseline reviewer** (`Codex Dev`) | `codex_local` | `gpt-5.6-sol` | `medium` | Codex JSONL gives tokens but no cost → `cost_usd = null` unless a rate card / allocation is recorded |
| **Candidate** (both roles) | `muse_code` (native Muse Code CLI) | current Muse contributor-tier model available to the operator; exact id read from the session banner and frozen in the run plan before run 1 | tier default; any reported setting is recorded and must not vary | recorded in the run plan before run 1 (see [Cost](#g6--cost-per-verified-completion)) |

The baseline pair is the one recorded in the production Dealer database (`~/.agent-dealer/dealer.db`) on 2026-09-19 when this contract was committed and used by issues NOT-158, NOT-167 and NOT-176: developer `Claude Dev` (agent `d353f7bd-654f-4bc8-a567-5cfb81f527aa`), reviewer `Codex Dev` (agent `5e438d1e-4ac2-4e7f-8a7b-07deda1863fa`). Developer-role tasks compare candidate against `Claude Dev`; the reviewer task compares against `Codex Dev`. The developer profile's model and effort are `null` in the frozen snapshots, so "exact model" for that arm is whatever the CLI resolved, captured per run — not assumed here. The candidate's model id likewise cannot be known until the adapter exists; freezing it is a precondition, not a guess.

`muse_code` is not yet a value of the Dealer `Runtime` enum; the adapter is a follow-up.

## Privacy decision

Contributor-tier prompts and completions **may be used to improve Meta products.**

1. **Operator acceptance is recorded first.** Before the first candidate run the operator writes `privacyAcceptance` into the run plan: `{ acceptedBy, acceptedAt (ISO 8601), statement: "I accept that prompts and completions from these runs may be used to improve Meta products.", termsVersionOrUrl, tasksCovered: [task ids] }`. No record, no candidate run.
2. **Only tasks marked non-sensitive run on the tier.** Every task in `tasks.json` carries `sensitivity.classification: "non_sensitive"` with a rationale; all 12 are historical changes or read-only questions about the public repository `github.com/not-so-fat/agent-dealer` at a pinned commit. A task without that field, or added later, must be classified and re-validated before it may run on the tier. Sensitive production work is out of scope.
3. **The Agent Deck is non-sensitive too.** Workers pull playbooks through the deck, so the evaluation uses one dedicated deck with non-sensitive playbooks only, no Linear service and no credentials. Playbook ids and content hashes are recorded in the run plan and reused for both arms. No secrets are placed in the worker environment.

## Comparison controls

Per task, baseline and candidate share the identical: rendered task prompt (Dealer's developer/reviewer prompt built from `workerSpec`), `startingSha` (detached checkout of the same commit), Agent Deck, role permission policy (developer: worktree write only; reviewer: read-only; neither may publish reviews, mutate outbound, or resolve human actions), `timeoutSeconds` (small 1200, medium 2400, long 3600) and verification commands. One valid paired sample per task (12 pairs). Arm order is alternated by task index to spread time-of-day and cache effects.

Only **infrastructure-invalid** attempts are rerun, and every such attempt is retained in the evidence. Infrastructure-invalid means the failure is provably not the model's: Dealer/harness crash, network or auth failure, deck unreachable, CLI failing before its first model turn, or account usage cap. Timeouts, wrong output, giving up, and tool misuse are **valid** runs and count against the arm. Classification is recorded from the log before verification runs.

Held-out tests: for tasks with `verification.heldOutPaths`, the test files (and fixtures) come from `referenceSha` and are copied in at verification time, replacing anything the worker wrote at those paths. The worker spec therefore states the interface contract the tests depend on. The clone's history contains the reference commits; a run whose transcript reads `referenceSha` content (for example `git show <referenceSha>`) is scored as failed for contamination, in both arms.

## Run protocol

1. Validate the manifest (below) and record the run plan: frozen candidate model id, both pricing bases and any subscription allocation, deck id and playbook hashes, `privacyAcceptance`, Dealer commit.
2. For each task and arm, create a fresh worktree at `startingSha`, launch the arm's profile with the task prompt, and capture the session log, `usage_events` row, wall time, and every human action.
3. After the session, run each verification command in the worktree with the task's setup (`npm ci`). `$ARTIFACT` is the worker's final message saved verbatim to `<runDir>/artifact.md`. A verification run is capped at 600 s; a hang counts as failure.
4. For developer-role runs, run the **fixed** reviewer (`Codex Dev`, one round, same for both arms) on the resulting diff to count change-request rounds. Its cost is excluded from both arms.
5. Read usage from `usage_events` rows, **never** from `summarizeIssueUsage`, which `COALESCE`s missing values to 0.

Reference validation (2026-09-19, scratch worktree after `npm ci`): each held-out command fails at `startingSha` and passes at `referenceSha`.

| Task | at startingSha | at referenceSha |
|---|---|---|
| muse-01 | exit 1 (1 fail) | pass 17 |
| muse-02 | exit 1 (2 fail) | pass 12 |
| muse-03 | hangs until `--test-timeout` (abort tests never end) | pass 6 |
| muse-04 | exit 1 (32 fail) | pass 92 |
| muse-05 | exit 1 (4 fail) | pass 86 |
| muse-06 | exit 1 (6 fail) | pass 33 |
| muse-07 | exit 1 (1 fail) | pass 21 |
| muse-08 | exit 1 (7 fail) | pass 34 |
| muse-09 | exit 1 (4 fail) | pass 28 |

muse-10/11 (answer-fact checks) and muse-12 (reviewer-result check) were exercised with synthetic passing and failing artifacts.

## Metrics and decision rubric

Definitions (N = 12 tasks, one valid run per task per arm, `x` ∈ {baseline, candidate}):

- **Verified completion**: a valid run in which every verification command exits with its `expectedExitCode` and matches `expectedResult` within the timeout. `V_x` = number of verified completions; **`C_x = V_x / 12`**.
- **Wall time `w_i`**: seconds from session spawn to exit or kill (`duration_ms`); timed-out runs count as `timeoutSeconds`; verification time excluded.
- **Human intervention**: any operator action after launch that changes a run's course (guidance, approval, manual edit, manual rerun of a valid attempt, clearing a human action). Infrastructure reruns are not interventions. **`H_x`** = total over the arm.
- **Change-request rounds `R_x`**: number of developer-role runs whose fixed-reviewer verdict is `changes_requested`. The reviewer task contributes 0.
- **Run cost `c_i`**: USD or `null`. **`K_x = Σ c_i`** over the arm's 12 valid runs (failures and timeouts included; infrastructure-invalid attempts reported separately, not summed). `K_x = null` if any `c_i` is `null`. **`CPV_x = K_x / V_x`**, undefined when `V_x = 0`.

The candidate advances only if **all six** hold:

| Gate | Formula |
|---|---|
| G1 completion floor | `C_candidate ≥ 0.80` (≥ 10 of 12) |
| G2 completion parity | `C_baseline − C_candidate ≤ 0.10` (`V_baseline − V_candidate ≤ 1`) |
| G3 speed | `median(w_i over 12 candidate runs) ≤ 1.5 × median(w_i over 12 baseline runs)` |
| G4 oversight | `H_candidate ≤ 1.2 × H_baseline` **and** `R_candidate ≤ 1.2 × R_baseline`; when a baseline value is 0 the candidate value must be 0 |
| G5 deck access | in every valid run, the log shows a successful `bind_workspace` and at least one successful playbook/deck read (`get_bound_deck` or `get_playbook`). Required of all 12 candidate runs; baseline reported as a control |
| G6 cost | `CPV_candidate ≤ 0.5 × CPV_baseline` (attributable cost per verified completion ≥ 50% lower), evaluated only when comparable |

### G6 — cost per verified completion

Missing token or cost data is `null` and makes the affected arm's cost incomparable. It is never treated as 0 and never yields a saving.

Both arms must be costed on the **same basis**, chosen in the run plan before run 1:

- **metered**: provider-reported per-run USD (e.g. Claude Code `total_cost_usd`);
- **token list rate**: `tokens_in × rate_in + tokens_out × rate_out` from published per-token rates (source and date recorded; cached-token handling stated; any run missing a token count is `null`);
- **subscription allocation**: `allocated_i = plan_price × (quota_consumed_i / quota_per_plan_period)`, where the quota consumed by the run and the plan's per-period allowance are provider-reported or published. Time-based allocation is not allowed. If the plan publishes no allowance and reports no per-run consumption, no honest allocation exists: **report both plans separately** (plan, price, period, runs, observed consumption) and mark the cost gate **incomparable**.

A contributor-tier cash price of $0 is reported but is payment in data, not a like-for-like cost; it cannot satisfy G6 by itself. Cost on a basis only one arm has is likewise incomparable.

### Outcome

| Outcome | Condition |
|---|---|
| **ADVANCE** | G1–G6 all pass |
| **DO NOT ADVANCE** | any of G1–G5 fails, or G6 is comparable and fails |
| **NOT ADVANCED — COST INCOMPARABLE** | G1–G5 pass but G6 is incomparable; report both cost views, claim no saving |
| **INCOMPLETE** | any task lacks a valid pair after infrastructure reruns |

## Validating the contract

```bash
node scripts/validate-muse-code-manifest.mjs   # shape, coverage, pinned commits
git diff --check
```

The script needs the full commit history. It checks: parseable JSON; exactly 12 tasks with every required field (`id`, `sourceIssue`, `repository`, `startingSha`, `workerSpec`, `role`, `category`, verification commands with `expectedExitCode` and `expectedResult`, `expectedArtifact`, `sizeClass`, `sensitivity`); coverage minimums (≥ 6 implementation, ≥ 2 test/debug, ≥ 2 repository exploration, ≥ 1 reviewer, ≥ 1 medium/long — currently 7 / 2 / 2 / 1 / 6); that `startingSha` and `referenceSha` resolve to real commits with `startingSha` an ancestor of `referenceSha`; and that each held-out path exists at `referenceSha` and is used by a verification command.
