# Changelog

Releases ship as **git tags** (`vX.Y.Z`) and **`npm install -g agent-dealer`** — see `docs/PUBLISHING.md`.

## Unreleased

- Plan-phase structured questions: agent asks up to 3 option-based questions; answering with options starts execution, free-form answers trigger a session-resumed replan (2-round cap).
- Self-triage auto-approve: plans marked `trivial` (no questions) skip human plan review; result review unchanged. Auto-approved runs are badged with rationale.
- `Skill` tool allowlisted in plan/execute/reflect phases — spawned agents can use installed skills (e.g. superpowers).
- New API: `POST /api/runs/:id/plan/answers`; snapshot gains `awaitingAnswerRuns`, `openQuestionCounts`, `autoApprovedRunIds`.

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
