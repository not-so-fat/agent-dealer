# Muse Code evaluation contract (NOT-176, epic NOT-164)

Fixed, budget-first contract for one question:

> Can **native Muse Code on the Muse contributor tier** materially reduce Agent Dealer execution cost while keeping acceptable task quality and reliability?

This document and [`tasks.json`](./tasks.json) are written **before** any adapter exists or any result is available. Nothing here is tuned to results. Changing a task, threshold, formula or subject after the first run starts invalidates the affected runs.

**Non-goals:** configuring Muse through Codex (Muse Spark via Codex is not the candidate), implementing the `muse_code` adapter, running the bakeoff, or running any sensitive production work on the contributor tier.

## Subjects

Every compared subject is frozen to an explicit runtime, model id, effort, CLI version and invocation. Nothing resolves from a CLI default during the experiment; the validator rejects `null` or descriptive values.

| | Runtime | Model | Effort | CLI | Pricing basis |
|---|---|---|---|---|---|
| **Baseline developer** (`Claude Dev`) | `claude_code` | `claude-sonnet-5` (`--model`) | `high` (`--effort`) | Claude Code 2.1.278 | list-rate shadow cost (G6 below); `total_cost_usd` recorded as a cross-check |
| **Baseline reviewer** (`Codex Dev`) | `codex_local` | `gpt-5.6-sol` | `medium` (`-c model_reasoning_effort=medium`) | codex-cli 0.150.0-alpha.12.2 | fixed review-loop instrumentation on muse-01…09 (excluded from `w_i`/`c_i`/`K`); the **baseline subject** on muse-12, where it is included; list-rate shadow cost |
| **Candidate** (both roles) | `muse_code` (native Muse Code CLI, contributor tier) | `muse-spark-1.3` (`--model`) | `high` (`--reasoning-effort`) | Muse Code 1.3.0 (1.3.0-R3401.1), `MUSE_NO_AUTO_UPDATE=1` | list-rate shadow cost (G6 below) |

The baseline pair is the one recorded in the production Dealer database (`~/.agent-dealer/dealer.db`) on 2026-09-19 when this contract was committed and used by issues NOT-158, NOT-167 and NOT-176: developer `Claude Dev` (agent `d353f7bd-654f-4bc8-a567-5cfb81f527aa`), reviewer `Codex Dev` (agent `5e438d1e-4ac2-4e7f-8a7b-07deda1863fa`). Developer-role tasks compare the candidate against `Claude Dev`; the reviewer task compares against `Codex Dev`.

- **Baseline developer.** The production profile leaves model and effort unset, so the CLI resolves them. On 2026-09-19 they resolve to `claude-sonnet-5` and `high` (operator `~/.claude/settings.json`: model alias `sonnet`, `effortLevel: high`; the Claude Dev session that authored this contract reports `claude-sonnet-5`). The evaluation uses an eval copy of the profile with both values set explicitly, so a later change to the CLI default cannot move the baseline between paired tasks. A run whose stream init event reports a different model id is infrastructure-invalid.
- **Candidate.** `muse-spark-1.3` is the highest `muse-spark-*` id embedded in the installed Muse Code 1.3.0 binary (`muse-spark-1.2` is also present). It has **not** been confirmed against the contributor tier: doing so sends a prompt to Meta before the privacy acceptance below exists. The operator confirms it before run 1 and records `candidate.confirmation.confirmedAt/confirmedBy` in `tasks.json`; if the tier serves a different current model the contract is amended and re-validated **before** run 1. `node scripts/validate-muse-code-manifest.mjs --ready` fails until that confirmation, and the Muse Code token mapping below, are recorded. `MUSE_NO_AUTO_UPDATE=1` stops the launcher swapping the binary mid-experiment.

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

1. Validate the manifest (below), run `node --test scripts/grade-muse-code.test.mjs`, confirm the candidate model (`--ready`), and record the run plan: frozen subjects (already in `tasks.json`), token-rate sources and retrieval dates, the Muse Code raw-field token mapping, actual plan spend to report, deck id and playbook hashes, `privacyAcceptance`, Dealer commit (`$EVAL_ROOT`).
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

muse-10/11 (structured answer keys) and muse-12 (claim catalogue) are covered by `node --test scripts/grade-muse-code.test.mjs`. It accepts a correct deliverable and rejects the false positives a keyword or regex grader would pass: an answer that names every symbol but denies each relationship, `sources` values wrapped in negation or prose (`not usage.input_tokens`), keyword-stuffed prose without the JSON block, two JSON blocks, an `approved` review, prose-only findings that state a defect perfectly, natural-language denials of a defect ("The claim that lease recovery ignores runtime availability is false", "The 24 h deferral ceiling is not untested", "recovery defers the item instead of dead-lettering it"), an asserted decoy claim, and an unknown claim id.

Nothing is graded by matching free prose, because no regex or blacklist can establish the polarity of a sentence. Exploration answers (muse-10, muse-11) must contain exactly one fenced JSON block whose fields are compared to `verification.answerKey` with exact normalized identifiers (`$equals`, `$oneOf`), sets and booleans; a value with surrounding words is a mismatch, and free-text fields do not exist. The reviewer task (muse-12) carries polarity structurally: the worker spec states a **claim catalogue** of six claims (three true defects, three false decoys, restated verbatim in `verification.claims`, which the validator checks). The reviewer emits a finding with fingerprint exactly `claim:<id>` for each claim it finds true and none for claims it finds false or cannot verify; a `claim:` fingerprint *is* the assertion. The result passes only if it parses as a `ReviewerResult` with the pinned SHAs and verdict `changes_requested`, asserts at least `minHeldClaims` (2) distinct true claims with a finding naming one of that claim's files, asserts **no** decoy, and uses no `claim:` id outside the catalogue. "Parses as a `ReviewerResult`" means every field the repository's Zod schema declares is validated, including the optional `productScopeQuestion` (a string when present) and each finding's optional `file`/`line`; a malformed artifact is rejected, not partially graded. The decoys make guessing lose: asserting every claim fails. Finding titles and rationales are recorded for humans but never affect the grade. Matches are reported as `n/3`.

## Metrics and decision rubric

Definitions (N = 12 tasks, one valid run per task per arm, `x` ∈ {baseline, candidate}):

- **Verified completion**: a valid run in which every verification command exits with its `expectedExitCode` and matches `expectedResult` within the timeout. `V_x` = number of verified completions; **`C_x = V_x / 12`**.
- **Human intervention**: any operator action after launch that changes a run's course (guidance, approval, manual edit, manual rerun of a valid attempt, clearing a human action) and each run ended by an `escalated` review verdict (one each). Infrastructure reruns and harness-driven remediation are not interventions. **`H_x`** = total over the arm.
- **Change-request rounds `R_i`, `R_x`**: for a run in the review loop, `R_i` is the number of reviewer rounds (max 3) whose verdict is `changes_requested`; a run needing three correction rounds contributes 3, one needing one contributes 1, and an `approved` first pass contributes 0. An `escalated` verdict terminates the loop, is **not** counted in `R_i`, and instead adds 1 to that run's human interventions (`H`). **`R_x = Σ R_i`** over the arm. A run still not `approved` after the cap (or ended by `escalated`) is flagged `unresolved` and keeps its `R_i` (it is not verified merely because rounds ran out; verified completion is judged on verification alone).
- **Wall time `w_i`**: seconds from spawn to exit or kill, summed over the run's subject sessions (the initial session — developer or, for muse-12, reviewer — plus any remediation developer sessions); a timed-out session counts as `timeoutSeconds`; review-loop reviewer passes and verification time excluded. Median is over the 12 runs.
- **Attempt cost `a_j`**: USD or `null`, on the list-rate shadow basis below, for one attempt (a subject session, including every remediation session). **Run cost `c_i`** = sum of `a_j` over the valid run's subject sessions (as defined for `w_i`); `null` if any is `null`. Review-loop reviewer passes are not `a_j` terms.
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

**One frozen basis for both arms: list-rate shadow cost.** Nothing about the pricing basis is left to the run plan. Whatever either arm actually pays (a subscription, a quota, a contributor-tier plan, metered API), the G6 number is its token usage priced at the vendor's published per-token rates for the frozen model. This is the documented conversion of plan usage to dollars; it needs no per-plan allowance and no time-based allocation, and it is applied identically to both arms, so list-rate and plan-allocated figures are never mixed. Rate source URL and retrieval date per model are recorded in the run plan before run 1 (`claude-sonnet-5`, `gpt-5.6-sol`, `muse-spark-1.3`). Claude Code's `total_cost_usd` is a baseline cross-check only and is never mixed in.

**Disjoint quantities.** Providers report cached tokens either outside or inside their input total, so summing raw fields double-counts. Cost is computed only from four disjoint quantities:

`cost = uncached_input × r_input + cache_read × r_cache_read + cache_write × r_cache_write + output × r_output`

Each frozen runtime's raw fields map to them as recorded in `tasks.json` (`tokenMapping`); costing reads the raw result/usage event, not `usage_events`:

| Runtime | `uncached_input` | `cache_read` | `cache_write` | `output` |
|---|---|---|---|---|
| `claude_code` (`result.usage`) | `input_tokens` (already excludes cache) | `cache_read_input_tokens` | `cache_creation_input_tokens` | `output_tokens` |
| `codex_local` (`turn.completed.usage`) | `input_tokens − cached_input_tokens` (cached is a **subset** of input; fixture `24763 − 24448 = 315`) | `cached_input_tokens` | `0` by definition (no cache-write tier) | `output_tokens` (`reasoning_output_tokens` is a subset, not added again) |
| `muse_code` (`muse exec --json`) | raw input, minus raw cached tokens if input is reported inclusive of cache | raw cached tokens | raw cache-write tokens, or `0` by definition if Meta has no such tier | raw output, reasoning counted once |

A quantity the vendor has no tier for is `0` by the mapping; a quantity that has a tier and is not reported is `null`. For Muse Code the adapter does not exist, so the operator records the exact raw field names and whether input includes cache in the run plan (and sets `candidate.tokenMapping.inputIncludesCached`) before run 1; if the log or Meta's documentation does not establish it, nothing is guessed and the candidate's cost is `null`.

**Actual plan spend is reported, not gated.** Alongside G6, report for each arm the plan, price, billing period, number of runs, and provider-reported consumption. A contributor-tier cash price of $0 is payment in data, not a like-for-like cost; it is reported and cannot satisfy G6. If Meta publishes no per-token rate for `muse-spark-1.3`, or Muse Code reports no token counts, the candidate's cost is `null`, G6 is **incomparable**, and both arms' actual plan spend is reported separately with no saving claimed.

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
node scripts/validate-muse-code-manifest.mjs --ready   # pre-run gate: fails until the operator confirms the candidate model and its token mapping
```

The validator needs the full commit history. It checks: parseable JSON; baseline developer, baseline reviewer and candidate each freeze a non-null runtime, model id, effort, CLI version, invocation (which must pass that model and effort explicitly), pricing basis and raw-field `tokenMapping`; a single `costModel` freezes the list-rate shadow basis and disjoint token quantities; a review loop with a round cap whose counted verdicts are exactly `changes_requested` and whose `escalated` handling is defined; exactly 12 tasks with every required field (`id`, `sourceIssue`, `repository`, `startingSha`, `workerSpec`, `role`, `category`, verification commands with `expectedExitCode` and `expectedResult`, `expectedArtifact`, `sizeClass`, `sensitivity`); coverage minimums (≥ 6 implementation, ≥ 2 test/debug, ≥ 2 repository exploration, ≥ 1 reviewer, ≥ 1 medium/long — currently 7 / 2 / 2 / 1 / 6); that `startingSha` and `referenceSha` resolve to real commits with `startingSha` an ancestor of `referenceSha`; that each held-out path exists at `referenceSha` and is used by a verification command; that each exploration task has a structured `answerKey` and grader command; and that the reviewer task's `claims` catalogue has unique ids, files that exist at `startingSha`, at least one false decoy, `minHeldClaims` within the number of true claims, each statement restated verbatim in the worker spec, and its pinned `headSha` equals `startingSha`.
