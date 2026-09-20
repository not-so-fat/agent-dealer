# Muse Code evaluation contract (NOT-176, epic NOT-164)

Fixed, budget-first contract for one question:

> Can **native Muse Code on the Muse contributor tier** materially reduce Agent Dealer execution cost while keeping acceptable task quality and reliability?

This document and [`tasks.json`](./tasks.json) are written **before** any adapter exists or any result is available. Nothing here is tuned to results. Changing a task, threshold, formula or subject after the first run starts invalidates the affected runs.

**Non-goals:** configuring Muse through Codex (Muse Spark via Codex is not the candidate), implementing the `muse_code` adapter, running the bakeoff, or running any sensitive production work on the contributor tier.

## Subjects

Every compared subject is frozen to an explicit runtime, model id, effort, CLI version and invocation. Nothing resolves from a CLI default during the experiment; the validator rejects `null` or descriptive values.

| | Runtime | Model | Effort | CLI | Pricing basis |
|---|---|---|---|---|---|
| **Baseline developer** (`Claude Dev`) | `claude_code` | `claude-sonnet-5` (`--model`) | `high` (`--effort`) | Claude Code 2.1.278 | token list rate (below); `total_cost_usd` recorded as a cross-check |
| **Baseline reviewer** (`Codex Dev`) | `codex_local` | `gpt-5.6-sol` | `medium` (`-c model_reasoning_effort=medium`) | codex-cli 0.150.0-alpha.12.2 | fixed review-loop instrumentation on muse-01…09 (excluded from `w_i`/`c_i`/`K`); the **baseline subject** on muse-12, where it is included; token list rate |
| **Candidate** (both roles) | `muse_code` (native Muse Code CLI, contributor tier) | `muse-spark-1.3` (`--model`) | `high` (`--reasoning-effort`) | Muse Code 1.3.0 (1.3.0-R3401.1), `MUSE_NO_AUTO_UPDATE=1` | token list rate (below) |

The baseline pair is the one recorded in the production Dealer database (`~/.agent-dealer/dealer.db`) on 2026-09-19 when this contract was committed and used by issues NOT-158, NOT-167 and NOT-176: developer `Claude Dev` (agent `d353f7bd-654f-4bc8-a567-5cfb81f527aa`), reviewer `Codex Dev` (agent `5e438d1e-4ac2-4e7f-8a7b-07deda1863fa`). Developer-role tasks compare the candidate against `Claude Dev`; the reviewer task compares against `Codex Dev`.

- **Baseline developer.** The production profile leaves model and effort unset, so the CLI resolves them. On 2026-09-19 they resolve to `claude-sonnet-5` and `high` (operator `~/.claude/settings.json`: model alias `sonnet`, `effortLevel: high`; the Claude Dev session that authored this contract reports `claude-sonnet-5`). The evaluation uses an eval copy of the profile with both values set explicitly, so a later change to the CLI default cannot move the baseline between paired tasks. A run whose stream init event reports a different model id is infrastructure-invalid.
- **Candidate.** `muse-spark-1.3` is the highest `muse-spark-*` id embedded in the installed Muse Code 1.3.0 binary (`muse-spark-1.2` is also present). It has **not** been confirmed against the contributor tier: doing so sends a prompt to Meta before the privacy acceptance below exists. The operator confirms it before run 1 and records `candidate.confirmation.confirmedAt/confirmedBy` in `tasks.json`; if the tier serves a different current model the contract is amended and re-validated **before** run 1. `node scripts/validate-muse-code-manifest.mjs --ready` fails until that confirmation is recorded. `MUSE_NO_AUTO_UPDATE=1` stops the launcher swapping the binary mid-experiment.

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

Graders and answer keys live in the Dealer checkout named by `$EVAL_ROOT` (the commit recorded in the run plan), not in the worker's worktree, and are run from there. A transcript that reads `docs/evaluations/muse-code` or `scripts/grade-muse-code.mjs` from any ref is also contaminated.

## Run protocol

1. Validate the manifest (below), run `node --test scripts/grade-muse-code.test.mjs`, confirm the candidate model (`--ready`), and record the run plan: frozen subjects (already in `tasks.json`), token-rate sources and retrieval dates, any subscription allocation, deck id and playbook hashes, `privacyAcceptance`, Dealer commit (`$EVAL_ROOT`).
2. For each task and arm, create a fresh worktree at `startingSha`, launch the arm's frozen profile with the task prompt, and capture the session log, `usage_events` row, wall time, and every human action.
3. **Review loop** (tasks whose artifact is `git_commits`, i.e. muse-01…09). The fixed reviewer (`Codex Dev`, same for both arms) reviews the resulting diff. If the verdict is `changes_requested`, the same arm's developer profile runs a remediation session in the same worktree with Dealer's rework prompt carrying the reviewer's findings (timeout = the task's `timeoutSeconds`), then the reviewer re-reviews. The loop stops on `approved`, after **3 reviewer rounds**, or when a remediation session fails or times out. An `escalated` verdict **terminates** the loop immediately: no remediation session runs, the run is flagged `escalated`, and it is recorded as one human intervention (Dealer would block on a human action) — it is **not** a change-request round and adds nothing to `R_i`. Each reviewer round whose verdict is `changes_requested` adds 1 to `R_i`. The reviewer sees the diff and the worker spec, never the held-out tests. Exploration and reviewer-role tasks have no diff and no loop (`R_i = 0`). Remediation is harness-driven and is not a human intervention. Two kinds of session are distinguished. **Subject sessions** are what each arm is being compared on: the initial session of every task (developer role for muse-01…11, reviewer role for muse-12, run by the arm's own profile) and every remediation developer session. They are included in `w_i`, `c_i` and `K`. **Review-loop reviewer passes** (the fixed `Codex Dev` instrument, identical in both arms) are excluded from `w_i`, `c_i` and `K` only. The muse-12 reviewer session is a subject session, not a loop pass: baseline = `Codex Dev`, candidate = native Muse Code reviewer, and its wall time and cost enter the 12-run median and `K_x` like any other task (a missing token kind makes it `null`, never 0).
4. After the loop, run each verification command in the worktree with the task's setup (`npm ci`), on the **final** tree. `$ARTIFACT` is the worker's final message saved verbatim to `<runDir>/artifact.md`; `$EVAL_ROOT` is the grader checkout. A verification run is capped at 600 s; a hang counts as failure. The pre-loop tree is also verified and reported, but only the final tree decides `V`.
5. Read per-run duration and status from `usage_events` rows, **never** from `summarizeIssueUsage`, which `COALESCE`s missing values to 0. Read token kinds for costing from the raw result/usage event of the session log (`usage_events` does not hold cache tokens).

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

muse-10/11 (structured answer keys) and muse-12 (known-defect matcher) are covered by `node --test scripts/grade-muse-code.test.mjs`. It accepts a correct deliverable and rejects the false positives a keyword grader would pass: an answer that names every symbol but denies each relationship, keyword-stuffed prose without the JSON block, two JSON blocks, an `approved` review with no findings, broad vocabulary in an unrelated file, correct-file text that dismisses the defect, and findings asserting the opposite of a defect (including the exact case "Lease expiry recovery consults runtime availability" / "recovery defers the item instead of dead-lettering it").

Exploration answers (muse-10, muse-11) must contain exactly one fenced JSON block whose fields are compared to `verification.answerKey` (function↔file pairs, field↔source, booleans; see `scripts/grade-muse-code.mjs`). The reviewer result (muse-12) passes only if it parses as a `ReviewerResult` with the pinned SHAs and at least one finding names a `knownDefects` file, matches every evidence group of that defect (which assert the defective relationship, e.g. "never consults `runtime_availability`"), **and** matches none of that defect's `contradicts` patterns (text describing the correct behavior, e.g. "defers the item instead of dead-lettering it"); verdict and shared vocabulary alone are not credited. Matches are reported as `n/3`.

## Metrics and decision rubric

Definitions (N = 12 tasks, one valid run per task per arm, `x` ∈ {baseline, candidate}):

- **Verified completion**: a valid run in which every verification command exits with its `expectedExitCode` and matches `expectedResult` within the timeout. `V_x` = number of verified completions; **`C_x = V_x / 12`**.
- **Human intervention**: any operator action after launch that changes a run's course (guidance, approval, manual edit, manual rerun of a valid attempt, clearing a human action) and each run ended by an `escalated` review verdict (one each). Infrastructure reruns and harness-driven remediation are not interventions. **`H_x`** = total over the arm.
- **Change-request rounds `R_i`, `R_x`**: for a run in the review loop, `R_i` is the number of reviewer rounds (max 3) whose verdict is `changes_requested`; a run needing three correction rounds contributes 3, one needing one contributes 1, and an `approved` first pass contributes 0. An `escalated` verdict terminates the loop, is **not** counted in `R_i`, and instead adds 1 to that run's human interventions (`H`). **`R_x = Σ R_i`** over the arm. A run still not `approved` after the cap (or ended by `escalated`) is flagged `unresolved` and keeps its `R_i` (it is not verified merely because rounds ran out; verified completion is judged on verification alone).
- **Wall time `w_i`**: seconds from spawn to exit or kill, summed over the run's subject sessions (the initial session — developer or, for muse-12, reviewer — plus any remediation developer sessions); a timed-out session counts as `timeoutSeconds`; review-loop reviewer passes and verification time excluded. Median is over the 12 runs.
- **Attempt cost `a_j`**: USD or `null`, on the token-list-rate basis below, for one attempt (a subject session, including every remediation session). **Run cost `c_i`** = sum of `a_j` over the valid run's subject sessions (as defined for `w_i`); `null` if any is `null`. Review-loop reviewer passes are not `a_j` terms.
- **Attributable cost `K_x`** = `Σ c_i` over the arm's 12 valid runs **plus** `Σ a_j` over the arm's infrastructure-invalid attempts. Paid infrastructure-invalid attempts (a harness crash or network failure after model usage) are real spend needed to reach a verified completion, so a non-null cost is included, not dropped. They are still listed separately for reliability reporting (attempt count, cause, cost). An infrastructure-invalid attempt with `null` cost contributes `0` only when the log proves no model request was issued (recorded as `noModelTurnEvidence: <log path>`); otherwise it is `null`. `K_x = null` if any term is `null`. **`CPV_x = K_x / V_x`**, undefined when `V_x = 0`.

The candidate advances only if **all six** hold:

| Gate | Formula |
|---|---|
| G1 completion floor | `C_candidate ≥ 0.80` (≥ 10 of 12) |
| G2 completion parity | `C_baseline − C_candidate ≤ 0.10` (`V_baseline − V_candidate ≤ 1`) |
| G3 speed | `median(w_i over 12 candidate runs) ≤ 1.5 × median(w_i over 12 baseline runs)` |
| G4 oversight | `H_candidate ≤ 1.2 × H_baseline` **and** `R_candidate ≤ 1.2 × R_baseline` (`R` = `changes_requested` rounds summed over the review loop; `H` includes one per `escalated` run); when a baseline value is 0 the candidate value must be 0 |
| G5 deck access | in every valid run, the log shows a successful `bind_workspace` and at least one successful playbook/deck read (`get_bound_deck` or `get_playbook`). Required of all 12 candidate runs; baseline reported as a control |
| G6 cost | `CPV_candidate ≤ 0.5 × CPV_baseline` (attributable cost per verified completion ≥ 50% lower), evaluated only when comparable |

### G6 — cost per verified completion

Missing token or cost data is `null` and makes the affected arm's cost incomparable. It is never treated as 0 and never yields a saving.

**Fixed basis (both arms, frozen now): token list rate.** `cost = Σ tokens_kind × published_rate_kind` over input, output, cache-read and cache-write tokens, using the vendor's published per-token rate for the frozen model (`claude-sonnet-5` for the baseline, `muse-spark-1.3` for the candidate). Rate source URL and retrieval date are recorded in the run plan before run 1. A run missing any token kind, or any model with no published rate, is `null`. Claude Code's `total_cost_usd` is a cross-check for the baseline only; a metered figure one arm has and the other lacks is not comparable and is never mixed in.

**Subscription or quota pricing** is used instead of list rates only if the operator's actual spend is a plan: `allocated_i = plan_price × (quota_consumed_i / quota_per_plan_period)`, where per-run quota consumption and the plan's per-period allowance are provider-reported or published. Time-based allocation is not allowed. If the plan publishes no allowance and reports no per-run consumption, no honest allocation exists: **report both plans separately** (plan, price, period, runs, observed consumption) and mark the cost gate **incomparable**.

A contributor-tier cash price of $0 is reported but is payment in data, not a like-for-like cost; it cannot satisfy G6 by itself. If Meta publishes no per-token rate for the frozen model, or Muse Code reports no token counts, the candidate's cost is `null` and G6 is incomparable.

### Outcome

| Outcome | Condition |
|---|---|
| **ADVANCE** | G1–G6 all pass |
| **DO NOT ADVANCE** | any of G1–G5 fails, or G6 is comparable and fails |
| **NOT ADVANCED — COST INCOMPARABLE** | G1–G5 pass but G6 is incomparable; report both cost views, claim no saving |
| **INCOMPLETE** | any task lacks a valid pair after infrastructure reruns |

## Validating the contract

```bash
node scripts/validate-muse-code-manifest.mjs   # shape, frozen subjects, coverage, pinned commits, grader keys
node --test scripts/grade-muse-code.test.mjs   # graders accept correct deliverables, reject false positives
git diff --check
node scripts/validate-muse-code-manifest.mjs --ready   # pre-run gate: fails until the operator confirms the candidate model
```

The validator needs the full commit history. It checks: parseable JSON; baseline developer, baseline reviewer and candidate each freeze a non-null runtime, model id, effort, CLI version, invocation (which must pass that model and effort explicitly) and pricing basis; a review loop with a round cap whose counted verdicts are exactly `changes_requested` and whose `escalated` handling is defined; exactly 12 tasks with every required field (`id`, `sourceIssue`, `repository`, `startingSha`, `workerSpec`, `role`, `category`, verification commands with `expectedExitCode` and `expectedResult`, `expectedArtifact`, `sizeClass`, `sensitivity`); coverage minimums (≥ 6 implementation, ≥ 2 test/debug, ≥ 2 repository exploration, ≥ 1 reviewer, ≥ 1 medium/long — currently 7 / 2 / 2 / 1 / 6); that `startingSha` and `referenceSha` resolve to real commits with `startingSha` an ancestor of `referenceSha`; that each held-out path exists at `referenceSha` and is used by a verification command; that each exploration task has a structured `answerKey` and grader command; and that the reviewer task's `knownDefects` name files that exist at `startingSha` with valid evidence and `contradicts` patterns and its pinned `headSha` equals `startingSha`.
