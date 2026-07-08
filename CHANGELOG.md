# Changelog

Releases ship as **git tags** (`vX.Y.Z`) and **`npm install -g agent-dealer`** — see `docs/PUBLISHING.md`.

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
