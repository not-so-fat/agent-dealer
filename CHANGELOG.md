# Changelog

Repo releases use **git tags** (`vX.Y.Z`) and GitHub Releases. Install from git — see `docs/PUBLISHING.md`. npm `agent-dealer@0.0.0` is a frozen name hold only, not the app.

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

### Gates

- `npm run flow:verify` — API lifecycle smoke
- `npm run poc:integration` — Linear / Agent Deck / CLI PoCs
