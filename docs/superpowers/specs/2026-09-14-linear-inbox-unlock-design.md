# Linear inbox unlock + free-form kick lookup

Date: 2026-09-14  
Status: approved

## Problem

Kick “From Linear” only showed a handful of tickets (e.g. NOT-90/89/47/46) because inbox candidates were filtered to assignee-me + narrow states (`Todo`/`Backlog` via env), capped at 30, with no way to paste `NOT-xx`.

## Goals

1. Show **open** Linear issues for the configured team (not only mine).
2. Include **In Progress** / **In Review**; exclude finished (`Done`, `Canceled`/`Cancelled`).
3. Remove the hard 30-result cap (paginate).
4. Allow free-form paste of `NOT-xx` or a Linear issue URL on kick.

## Non-goals

- Sequential queue (NOT-103)
- Auto-import inbox without human kick
- Changing team filter semantics

## Behavior

### Defaults

| Setting | New default |
|---------|-------------|
| `stateFilter` | `Backlog`, `Todo`, `In Progress`, `In Review` |
| `assigneeMe` | `false` (settings toggle remains) |
| Team | unchanged (`LINEAR_TEAM_ID` / saved) |

Env `LINEAR_STATE_FILTER` still overrides saved filter when set — update examples and local `.env` to the open-state set so live override matches product intent.

One-shot DB migrate: set persisted `assigneeMe` to `false` for existing installs (unlock without a manual settings click).

### List

`listLinearCandidates` pages Linear (`first: 50` + cursor) until exhausted, then drops already-promoted actives.

### Free-form kick

On Issues “From Linear”:

- Text field accepts identifier (`NOT-103`), UUID, or Linear URL.
- Resolve via Linear `issue(id:)` (accepts identifier or UUID).
- On success: select that candidate (merge into local list if missing), lock title/description like dropdown.
- On failure: inline error; do not create.

## Acceptance

- [ ] Open-state defaults; finished states excluded
- [ ] `assigneeMe` defaults / migrates off; toggle still works
- [ ] Inbox returns >30 matching issues when Linear has them
- [ ] Paste `NOT-xx` or URL resolves and fills kick form
- [ ] `.env` / examples updated so env override does not re-narrow to Todo+Backlog only
