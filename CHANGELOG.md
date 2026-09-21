# Changelog

Releases ship as **git tags** (`vX.Y.Z`) and **`npm install -g agent-dealer`** / managed install — see `docs/PUBLISHING.md`.

## 1.1.6 — 2026-09-21

Patch over 1.1.5: a filterable, paginated Issues list, a more readable Execution report, and a tidier navigation shell.

### Features

- **Issues list filters and pagination (NOT-228)** — the Issues page history now has a filter bar (search across title and external label, status, exact repository, Needs attention) that applies on **Apply**, with applied filters and the page persisted in the `/issues` query string so views are linkable and survive reload. The list shows `Showing X–Y of N` with Previous/Next, and a filter-specific empty state with **Reset** (distinct from the first-run empty state). The New issue form, Admission queue and Needs-attention panel stay global and unfiltered.
- **Paginated `GET /api/issues` (NOT-228)** — passing `page` and/or `limit` (default 25, max 100) returns `{ issues, page, limit, total, totalPages }` in stable `updated_at DESC` order, and enables the filters `q` (title / external label), `status` (comma-separated), `repo` (exact) and `needsAttention` (`1` or `true`). Filters apply only in paginated mode; without `page`/`limit` the endpoint returns the legacy array exactly as before (still honouring `status` only), so existing API consumers are unaffected.

### UI

- **Readable Execution report (NOT-229)** — clearer hierarchy on the Execution report page: percentile and coverage values are laid out as labelled figures, missing data reads **Unavailable**, large token counts are compact (e.g. `1.2K`, `1.2M`), and the failure section is now titled **Why attempts failed**. Presentation only: the `GET /api/execution-report` response is unchanged.
- **Dashboard header name and nav order (NOT-227)** — the dashboard header now shows **Monaco** as its display name (previously "AgentDealer"; unrelated to the Monaco font), and Issues now comes before Reports in the nav. The browser tab title, CLI, npm package name and `agent-dealer` command are unchanged.

## 1.1.5 — 2026-09-21

Patch over 1.1.4: execution analysis — see where time and retries go per issue and compare runtimes and models across a fleet — plus small UI and CLI polish.

### Features

- **Per-issue execution analysis (NOT-173, NOT-174)** — Issue Detail now shows execution phases, failure state, observational silence intervals, and failed-attempt/retry waste with per-attempt reuse badges. Backed by new issue and cohort execution-analysis APIs that carry quality/coverage metadata; cohort aggregates cover the full matching window (not just the current page), and attempt filters (role/runtime/model/status) scope waste, retry, reviewer and failure metrics too.
- **Runtime and model execution-comparison report (NOT-175)** — a new Execution report page under **Reports** in the nav (`/reports/execution`, backed by `GET /api/execution-report`) compares runtimes and models with URL-persisted filters, coverage tables, failure buckets, per-row waste/retry columns and cohort deep links.
- **Version on `start` (NOT-224)** — `agent-dealer start` now prints `Agent Dealer version X` (not in supervisor mode), and `agent-dealer status` labels its existing version line the same way instead of `CLI package X`.

### UI

- **New issue panel placement (NOT-223)** — the New issue form now renders directly below the header, above the admission queue. Presentation order only.
- **Avenir for UI chrome, Monaco for values (NOT-222)** — the `--font-ui-display` token now resolves to an Avenir-first system stack for navigation, headings and buttons; form fields and value-bearing selects stay in Monaco.

### Internal

- **Activity and checkpoint evidence (NOT-170, NOT-172)** — structured session activity is persisted (new `session_activity_events` table, migrated automatically on start) and silence intervals are derived from it. First-checkpoint and retry-reuse evidence is emitted from developer sessions, with the worktree HEAD captured at session start as the sampler baseline. This is the evidence the analysis above reads. It is observational only: the new emitters are best-effort and never fail or alter an attempt.

## 1.1.4 — 2026-09-21

Patch over 1.1.3: queue controls (configurable concurrency, Execute now, queued agent reassignment), safer push/repair recovery, and durable failure-cause and timing evidence.

### Features

- **Configurable active-issue concurrency (NOT-215)** — the Issues page header now sets how many issues run at once (1–2, default 1, persisted across restarts and clamped to the worker/spawn ceiling). At most one active issue per repository; same-repo waiters stay queued with a concrete reason. Lowering the limit never preempts running issues. Adds `GET /api/queue/status` and `PUT /api/queue/settings`.
- **Execute now and queued agent reassignment (NOT-217)** — a queued issue can be started immediately (`POST /api/issues/:id/execute`, `issue execute` in the CLI, and a UI action) with the same eligibility and capacity checks as normal admission; it only bypasses queue order. A queued issue's agent can be changed in the UI without losing its queue position, with an `issue.reassigned` audit event.
- **Push with lease on diverged pushes (NOT-221)** — when an `unpushed_commit` escalation has a diverged branch, the dashboard shows the diverging SHAs and offers **Push with lease** alongside Resume and Close.
- **System display font for navigation and headings (NOT-216)** — navigation, headings, buttons, selects and links now use a single `--font-ui-display` design token (a system font); Monaco is kept for operational content. It is a design token, not a user setting.

### Fixes

- **Repair rounds start from the pushed tip (NOT-219)** — a repair round is now cut from the fetched `origin/<branch>` tip rather than the clone's stale local issue branch, and the local ref is fast-forwarded (best-effort) after push. A fetch failure defers the round instead of starting from stale state.
- **Diverged push auto-recovery (NOT-220)** — when the remote tip is Dealer's last-known head and the local branch is patch-equivalent, the push is recovered automatically with a lease pinned to that SHA (auditable `branch.pushed` event, no escalation).

### Internal

- **Normalized failure causes (NOT-171)** — a shared failure-cause contract and classifier is applied to observed failures and recovery reclaims, persisted append-only in `failure_causes` with raw error/reason/log/events untouched. Legacy rows are backfilled as inferred on read.
- **Durable timing evidence (NOT-168, NOT-169)** — queue and admission wait history is now recorded as `queue.*` events. New `agent.started`, `agent.completed` and `host.suspended` events let setup, agent-process, validation and host-sleep intervals be derived exactly.

## 1.1.3 — 2026-09-20

Patch over 1.1.2: three review-loop and queue fixes so a stale base or a hand-merged PR no longer stalls issues or their dependents.

### Fixes

- **Issue branches start from the latest base (NOT-197)** — a fresh developer branch is now cut from a freshly fetched `origin/<base>` instead of the cached clone's possibly stale local base, so PRs no longer conflict with work merged while the issue was queued. The fetched SHA is recorded as the issue's `base_sha`. If the fetch fails or times out, no branch is created and the issue is deferred and retried automatically, without spending an infra attempt or a review round. Reusing an existing branch is unchanged.
- **Merge failure after approval offers Retry merge (NOT-194)** — when auto-merge fails after the review is approved, the parked action now offers **Retry merge**, **Another repair round** and **Close** instead of only Resume development or Close. The failure text is shown verbatim.
- **Closing an issue whose PR was already merged (NOT-196)** — when a human action is resolved with `close` (or an issue is aborted) and the issue's PR is `MERGED` on GitHub, the issue now ends `done` with an event recording the external merge, so its dependents are released. If the PR is open, closed unmerged, or absent, the issue is `closed` as before; if the PR state cannot be read, it is `closed` and the event records that the merge state was unknown, never `done`. `blockerVerdict` is unchanged, and an abort from a status with no route to `done` still ends `closed`.

## 1.1.2 — 2026-09-20

Patch over 1.1.1: internal groundwork for Muse Code isolation; no change to how existing runs behave.

### Internal

- **Muse Code per-attempt config (NOT-180)** — adds a module that builds the isolated config for one Muse Code attempt (single Agent Deck MCP server, sandbox on, approvals never, filtered env, reviewer write/shell disabled) and refuses restrictions that cannot yet be enforced. It is not yet wired into the Muse runner, so Muse runs are unchanged.

## 1.1.1 — 2026-09-20

Patch over 1.1.0: stop/start safety fixes (`stop` for isolated homes, `start --force` port check) and a false usage-cap deferral fix.

### Fixes

- **`agent-dealer stop` with an isolated home** — with an explicit `AGENT_DEALER_HOME` and no `run.json`, `stop` no longer falls back to the default port and terminates whatever listens there (previously it could stop your real install). It now only stops the pids recorded in that home's own `run.json`.
- **`start --force` port check** — exits with an error whenever an agent-dealer is still listening on the port after the forced stop (for example one owned by a different home), instead of launching a second server onto an occupied port.
- **False Claude usage-cap deferral** — for Claude rate-limit events, only a rejected plan-window `status` now defers an issue; a rejected `overageStatus` alone (orgs with pay-as-you-go disabled, `status` still allowed) is ignored. Other usage-cap signals (billing errors, cap error text) are unchanged.

### Internal

- `install:smoke` only runs its cleanup `stop` while its temp `run.json` still exists, so a release smoke can no longer take down the developer's running instance.

## 1.1.0 — 2026-09-20

Minor over 1.0.5: an opt-in trial of native Muse Code as the developer agent, plus review-loop, retry and Linear-error refinements.

### Features

- **Muse Code developer trial (opt-in per issue)** — supervised trial only: the PoC recommended “retry later”, and contributor-tier content may be used for product improvement, so pick non-sensitive tickets. Choose a Muse Code developer profile (pinned model) and the issue runs the normal Dev-review workflow, with Codex/Claude as reviewer (Muse cannot review). Muse gets no MCP and no Agent Deck, so a deck outage never parks it; token counts are recorded when Muse reports them, and cost is always empty (NOT-178, NOT-179, NOT-181).
- **Muse health checks** — tells a missing CLI from missing credentials from an unexplained probe failure (NOT-178).
- **Muse failure handling** — auth failures retry as infra without spending a review round, usage caps defer the issue, and a session that used Muse’s `cron_*` tools is failed and escalated to you with no retry. That last check runs after the fact and cannot prevent a job from firing (NOT-181).
- **`usage_events.model`** — developer usage records now store the model (the confirmed model for Muse, the profile’s model otherwise); reviewer rows stay empty. An automatic migration adds the column and older rows stay empty (NOT-181).

### Improvements

- **Early escalation on repeated blockers** — a file with a blocking review finding in each of the last 3 rounds raises a policy escalation naming the file(s) instead of queuing another developer round; resuming spends the skipped repair round, and three fresh rounds are needed before it can fire again (NOT-184).
- **Edit, then retry** — an issue parked at `attempts_exhausted` now lets you edit its title, description and acceptance criteria (`PATCH /api/issues/:id`); retrying re-freezes the task snapshot if any changed and records a `task_snapshot.refreshed` event (NOT-185).
- **Findings resolve themselves** — a later completed review that no longer reports a finding marks it resolved (NOT-186).
- **Clearer Linear blocker errors** — names the cause, and the rate-limit reset ETA, when blocker state is unavailable (NOT-158).

### Internal

- **Muse evaluation** — budget-first evaluation contract, headless/orchestration spike, PoC results, and the committed PoC harness in `scripts/muse-poc/` (NOT-176, NOT-177, NOT-183, NOT-187). Opt-in paid real-CLI check: `MUSE_SMOKE=1 npm run smoke:muse`.
- **Execution analysis** — contract and evidence-quality rules for analysing runs (NOT-167).

## 1.0.5 — 2026-09-19

Patch over 1.0.4: Agents list shows the effective model for profiles saved before NOT-71.

### Fixes

- **Agents list model badge** — shows the effective model (`defaultModel`, falling back to the legacy execute/plan model), so older profiles no longer show a blank model badge (NOT-80).

### Internal

- Regression tests lock the agent form's model/budget field set (NOT-80).

## 1.0.4 — 2026-09-19

Patch over 1.0.3: stop false agent-health failures from parking the queue (Claude MCP + reviewer-vs-developer admit).

### Fixes

- **Claude mcp-launch stdio** — dealer health no longer treats Claude’s MCP launch stdio as “MCP not registered”, which stuck the queue forever (NOT-155).
- **Admission role health** — only the developer must be healthy to admit; reviewer health is checked when review is due, so one unhealthy reviewer no longer parks the whole queue before development starts (NOT-156).

## 1.0.3 — 2026-09-19

Patch over 1.0.2: diagnose Linear API-key burns, and stop sleep/wake Cursor probes from parking the queue.

### Fixes

- **Linear API-key usage observability** — always-on per-operation GraphQL counters, `GET /api/debug/linear-usage`, and durable JSONL at `$AGENT_DEALER_HOME/logs/linear-usage.jsonl` (no env flag required; `AGENT_DEALER_LINEAR_TRACE=1` is stderr-only) (NOT-159).
- **Cursor probe timeouts** — soft-fail so host sleep/wake does not park the queue as unhealthy (NOT-157).

## 1.0.2 — 2026-09-18

Patch over 1.0.1: queue UX, Linear observability, docs landing, and migrate hygiene.

### Product

- **Queue reorder** — move queued issues in the UI/CLI/API (NOT-112).
- **Architecture docs** — independent-workflows design + plan + CONTEXT/README (NOT-69).

### Fixes

- **Linear GraphQL failures** — log HTTP status and rate-limit headers; 429-aware backoff for dependency fetches (NOT-152).
- **Direct-start temp home** — interrupt/`process.exit` no longer abandons the temp `AGENT_DEALER_HOME` (NOT-140).
- **Builtin agent seed** — migrate only seeds Claude/Cursor/Codex when the agents table is empty (do not resurrect deleted defaults).

## 1.0.1 — 2026-09-18

Patch over 1.0.0: auto-merge + reviewer contract fixes for the issue Dev→PR→Review path.

### Fixes

- **Auto-merge after portable repos** — merge `gh` uses the managed clone path, not `github.com/…` as cwd (that looked like `spawn gh ENOENT`). Missing clone fails with a clear reason; bad-cwd vs missing-`gh` are distinguished.
- **Friend-path docs** — install/setup tips and PROD_SETUP state `gh` + `gh auth login`, prefer managed `~/.local/bin`, and doctor green before kicking issues.

### Reviewer contract

- **Blocking / truncate ⇒ changes_requested; shippable ⇒ Merge** — reviewer + coordinator verdict contract (NOT-150) so incomplete or blocking findings cannot read as shippable.

## 1.0.0 — 2026-09-18

First major release: **issue queue + Dev→PR→Review** replaces the older run-oriented plan/execute product.

### Breaking

- **Dashboard is Issues + Agents only** — Operations, Inbox, Done, and the standalone Human actions screen are gone with the legacy run UI.
- **No more plan/execute runs** — kick an issue, watch Dev→PR→Review, resolve what needs you. Existing data stays; old outbound-delivery blockers remain resolvable.

### Product

- **Needs your attention on Issues** — open human actions live on the Issues home (count in the nav); open an issue or resolve inline.
- **Deep links** — shareable URLs for issues, issue detail, and agents.
- **Linear kick** — freer inbox filters and lookup; pick a recent repo and optional auto-merge per issue.
- **Re-import is a no-op** — a Linear ticket that already finished as an issue will not mint a duplicate.
- **Repos by GitHub repo URL** — no Agent workspace/playbook path in the product surface.

### Execution

- **One issue at a time** — new issues enqueue; Start moves one to the front. Survives crash/restart; Abort, guidance, and evidence are first-class.
- **Agent Deck from the profile** — workers use the profile’s deck; playbooks are checked before spend.
- **Reasoning effort on profiles** — set once; frozen for the run.
- **Runs recover instead of dying quietly** — caps, sleep, and timeouts no longer strand work; the issue UI shows live progress and why something failed.
- **Retries keep what already worked** — verified steps and pushed commits are reused; unpushed work shows how far the branch diverged.

### CLI

- **Issue lifecycle** — create, list, start, guidance, evidence, and actions from the CLI as well as the dashboard.

### Install path (unchanged)

- Managed: `curl …/scripts/install.sh | bash` → `agent-dealer setup` → `agent-dealer start --open` → http://localhost:2222
- Compat: `npm install -g agent-dealer`

## 0.3.0 — 2026-09-09

### Runtimes

- **`codex_local`** — first-class local Codex CLI runtime (`codex exec --json`): phase sandboxes, JSONL→artifact mapping, QA allowlist, health/models/UI, and Claude-parity session resume on feedback execute / QA
- **Model picker** — Codex models from `~/.codex/models_cache.json` (`visibility=list` only), with `gpt-5.6-sol` / `terra` / `luna` fallback
- **Health** — `codex login status` for auth; remediation points at `OPENAI_API_KEY`

## 0.2.0 — 2026-07-30

### Managed CLI install + auto-upgrade

- **Recommended install:** `agent-dealer install` (or `scripts/install.sh`) → `~/.agent-dealer/versions/` + `~/.local/bin/agent-dealer` — **existing config/queue/logs untouched**
- **Auto-update on by default** for managed installs (background check; activate on next `start` / `doctor` / `upgrade`)
- **Opt out:** `AGENT_DEALER_DISABLE_AUTOUPDATER=1`
- **`upgrade`:** managed path activates the version tree; npm-global path still uses `npm i -g` (compat)
- **doctor:** reports install kind + managed current / pending
- **Docs:** README + PUBLISHING friend path

### After upgrade

- New users: `curl -fsSL …/scripts/install.sh | bash` then `export PATH="$HOME/.local/bin:$PATH"`
- Existing `npm i -g` users: optional `agent-dealer install` (CLI binary only — no data migration)
- Restart any running daemon after managed activate

## 0.1.13 — 2026-07-21

### Review drawer

- **Arrow keys in fields** — Left/Right no longer advance the review queue while the caret is in an input, textarea, or other editable control

### Build / CI

- **Lockfile + CLI workspace pins** — CLI `@agent-dealer/shared` / `server` match the release version so `npm ci` resolves workspaces (fixes main CI 404 on unpublished scoped packages)

## 0.1.12 — 2026-07-21

### Manual task identity

- **Manual runs mint `external_id`** — set to the first run’s `id` at create (same stable task-key pattern as Linear); copied on retry. `external_label` stays null for manual.

## 0.1.11 — 2026-07-14

### Review drawer — reading surfaces

- **Result** — expand/collapse like Plan (`Show full result` / `Show summary`); defaults to full natural height instead of a tight scroll box
- **Deliverable / Document** — render markdown instead of a raw readonly textarea

## 0.1.10 — 2026-07-13

### Outbound soft gate

- **Execute may `call_service_tool`** — no longer denied mid-run so Linear/GitHub/Docmost (and similar) writes can complete; plan / reflect / qa still deny the tool
- **Prompt** — prefer draft → Approve & send for Slack/email; do not claim the tool is blocked
- **Draft schema** — `actionType: service_tool_call` → `service_draft` artifact for optional gated delivery of arbitrary deck-service writes

## 0.1.9 — 2026-07-12

### CLI — daemon lifecycle

- **`agent-dealer start --daemon`** — detached supervisor; survives terminal close; logs under `~/.agent-dealer/logs/`
- **`agent-dealer status`** — PID, port, health, log paths
- **`agent-dealer stop`** — graceful shutdown of a running daemon
- **`start --force`** — replace an existing listener on the port

### Execution pipeline — reliability

- **Orphan recovery** — `running` rows left by a restart are swept to `failed` at startup (retryable)
- **Cancel safety** — cancelling a run kills the child process; late completions no longer crash the daemon
- **Empty-plan cap** — repeated empty plan results fail after 3 attempts (no infinite spend loop)
- **Wall-clock timeouts** — plan (15m) and execute (60m) kill stalled agents and free concurrency slots
- **Global spawn cap** — plan, execute, reflect, and Q&A share `MAX_CONCURRENT_RUNS`
- **Live transcripts** — stdout streams to ndjson during the run; `/log-tail` works on in-flight runs

### Outbound send gate

- **Sent-before-deliver** — draft marked `sent` atomically before MCP call; reverted to `pending` on failure (no double-send race)
- **Retry guard** — `/retry` returns 409 while a deliver is in flight
- **Deliver timeout** — MCP outbound calls time out after 60s (`DELIVER_TIMEOUT_MS`)
- **Review drawer** — edit outbound message body before approve/send

### Security

- **Localhost only** — API binds `127.0.0.1` (not `0.0.0.0`)

### Docs

- **README** — story-first rewrite of the product path
- **PROD_SETUP** — daemon commands and ops notes

## 0.1.8 — 2026-07-11

### Playbook learning (Agent Deck 1.4.0)

- **Reflect → proposal queue** — post-review reflect posts item-delta patches to Agent Deck `POST /api/playbook-patches` (`source: dealer`) instead of inline apply/dismiss in the review drawer
- **Review drawer** — shows proposal id, rationale, and **Review in Agent Deck** link; accept/reject happens in the deck dashboard
- **Prompt** — reflect outputs `{ rationale, ops[], evidence? }` (prefer `add_item` gotchas over full-body rewrites)

### CI

- **GitHub Actions** — build, typecheck, unit tests, and `flow:verify` API gates on every push/PR to `main`
- **flow:verify** — CI-safe when Claude CLI is absent (retry gate before approve; accepts fast-fail execution states)

## 0.1.7 — 2026-07-08

### Fixed

- **Cursor CLI** — resolve and invoke `cursor-agent` directly (`cursor-agent login`, `-p`, `--list-models`, `status`). Fixes `cursor_local` on machines that only have the standalone CLI from `cursor.com/install`, without the editor's `cursor agent` shim.

## 0.1.6 — 2026-07-08

### Plan review UX

- **Replan with feedback** — compact button under Plan review expands a comment box; agent revises from your notes (`draft-plan` accepts `feedback`)
- **Edit & replan / execute** — direct markdown edit with **Replan**, **Execute**, or **Cancel** (cancel warns and reverts unsaved edits)
- **Pipeline panels** — In Planning / In Progress ticket overlays use solid `#0F0F0C` so lists are readable over Review Plan
- **Drawer scroll** — plan, result, done, and Q&A markdown panels flow in the main drawer scroll (no nested scroll traps)

### CLI

- **`agent-dealer upgrade`** — install a specific or latest published version (`--to`, `--yes`)
- **Update check on start/doctor** — throttled npm registry check; optional prompt or `AGENT_DEALER_AUTO_UPGRADE=1`

### Changed

- **Result Q&A** — `cursor_local` runs can ask questions (ask mode + session resume fallback)
- **API** — `POST /api/runs/:id/draft-plan` accepts optional `feedback` and `editedMarkdown` for guided replans

## 0.1.5 — 2026-07-08

### Result Q&A (`docs/superpowers/specs/2026-07-07-result-qa-and-plan-delegation-design.md`)

- **Ask the agent** — question box in the review and done drawers; a new read-only `qa` phase resumes the execute session (`Read,Glob,Grep,Skill` only, fixed 6-turn / $0.25 cap) instead of re-running execution
- **Append-only thread** — each exchange persists as a `result_qa` artifact; latest artifact per `exchangeId` wins; one pending question at a time
- **Retry carries the discussion** — answered exchanges render as `## Review Q&A` in the execution prompt, inherited from the lineage parent, so a retry needs no copy-paste
- **Graceful fallback** — expired execute session answers from artifacts (approved plan, execution outcome, deliverable) and the UI flags it; a failed Q&A never changes run status
- **API** — `POST /api/runs/:id/qa`; `qa` usage lines roll up as `Q&A` in the usage summary

### Changed

- **Approving a plan with open questions is now an explicit delegation.** The button reads "Proceed — agent decides", the approve route records a `plan_answers` artifact with the new `delegated` outcome, and the execution prompt lists the unanswered questions under `## Unanswered plan questions`. Previously the questions were silently dropped, so the executor never learned the planner had flagged the plan as underspecified.

## 0.1.4 — 2026-07-08

### Outbound send gate (`docs/PRD_SEND_GATE.md`)

- **Enforcement** — `--disallowedTools` blocks `call_service_tool` in all phases; execute gains `list_service_tools`; `Bash` removed for communication/email tasks
- **Draft contract** — execute replies end with a fenced JSON outbound block; server extracts `slack_draft` / `email_draft` artifacts (pending) and strips the block from stored results
- **Approve & send** — result review delivers stored `toolCall` verbatim via Agent Deck MCP, persists `send_receipt`, then transitions to done; deliver failure keeps run in review
- **Dashboard** — outbound section in review drawer; `pendingSendCounts` on snapshot; done runs show sent badge when receipt exists
- **Verification** — `packages/server/src/queue/send-gate.test.ts`; `scripts/poc/agent-deck-send.ts` (skip when Slack env unset)

## 0.1.3 — 2026-07-07

Plan questions, review-drawer execution config, and correctness fixes from code review.

- **Plan questions (F2/F3/F4)** — structured option cards; free-form answers trigger replan; 2-round cap; self-triage auto-approve for trivial plans; needs-answer lane + badges
- **Review drawer** — execution model/budget on plan approve, plan answers, kick, and retry; usage lineage rollup with at-cap highlights; collapsible trace/replan sections
- **Correctness** — guard execute model/budget passthrough (null Default no longer wipes seeded values; null clears run-level budget override); snapshot usage caps at persist time; plan approve marks triage consumed before transition; redraft path skips execution config; triage fence stripped on parse fallback
- **API** — `POST /api/runs/:id/plan/answers`; snapshot fields `awaitingAnswerRuns`, `openQuestionCounts`, `autoApprovedRunIds`

## 0.1.2 — 2026-07-06

Configurable per-phase budgets; real runs default to Claude runtime limits (no CLI caps).

- **Budget model** — plan and execution resolved separately; omit `--max-turns` / `--max-budget-usd` when unset (runtime default)
- **Agent defaults** — optional plan/execution max turns and USD on Agents page
- **Per-run overrides** — plan review (replan + approve) and execution kick accept phase budgets
- **UI** — `PhaseConfigRow`: model · turns · max USD in one row per phase
- **Testing** — `flow:verify` passes explicit test caps; legacy `budget_json` maps to execute-only

## 0.1.1 — 2026-07-06

Patch: production config loading for npm install users.

- CLI `start` / `doctor` load `~/.agent-dealer/.env` before port resolution and server spawn
- Bundled install listens on **2222** (ignores legacy `PORT=2221` in old templates)
- `doctor` reports `LINEAR_API_KEY` and effective port; setup template defaults to 2222

## 0.1.0 — 2026-07-06

First agreed daily-driver release (git tag `v0.1.0`).

### Operations & review

- Four-column Operations layout: narrow In Planning / In Progress strips + Review Plan / Review Result
- Markdown preview for plans, deliverables, and approved plan in review drawer
- Lineage **usage rollup** (plan, execute, retry, total) and **chronological reasoning trace**
- Execution **retry** re-runs with same approved plan (not replan); Linear → In Progress
- Retry continues prior work (`--resume`, deliverable seed, prompt/trace context)

### Integrations

- Linear write-back at plan / review / retry / done milestones
- Post-review playbook reflect + propose-confirm patch (Agent Deck)

### Install

```bash
npm install -g agent-dealer
agent-dealer setup
agent-dealer start --open
```

Dashboard + API on **http://localhost:2222** (bundled static UI).
