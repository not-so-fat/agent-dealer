# Agent-operated Dev-review happy path (NOT-79)

The exact, minimal CLI/API sequence for a fresh operator or coding agent to drive one
`dev_reviewer_v1` issue from creation through `done`, without opening the dashboard. This
is the supported happy path — it is exercised end to end by
`packages/server/src/dev-review-cli-happy-path.integration.test.ts` against real git,
a real coordinator, and controlled worker/provider fixtures.

Every command below uses the CLI's `--help`-documented surface (`agent-dealer <command>`)
against a running `agent-dealer start` instance.

## 1. Discover an Agent profile

```bash
agent-dealer agent list
```

Each entry includes `id`, `runtime`, `defaultModel`, `workspaceRoot`, `deckId`/`deckName`,
and `healthy`. Pick (or, via the dashboard/API, create) a developer and a reviewer
profile — for a real Agent Deck-backed run, both should carry a `deckId`. Cursor
(`cursor_local`) currently has no execution-authority isolation mechanism (see
`agent-deck-bind.ts`), so a deck-bound profile must use `claude_code` or `codex_local`.

## 2. Create the issue

```bash
agent-dealer issue create \
  --title "Add widget" \
  --repo /path/to/target/repo \
  --developer-agent <developerAgentId> \
  --reviewer-agent <reviewerAgentId> \
  --acceptance-criteria "Widget renders." \
  --base-branch main
```

Creating **enqueues the issue for admission** — it never starts a workflow directly, so
creating several in a row is always safe. Pass `--no-enqueue` for a draft that stays out of
the queue until you add it back (`agent-dealer queue add <issueId>`) or start it.

`acceptance-criteria` can be omitted at create time; the issue then waits in the queue with
the wait reason `missing acceptance criteria` instead of starting. Adding criteria (via the
API/dashboard — there is no `issue update` CLI command yet) unblocks it on the next
coordinator tick, with no action to resolve.

```bash
agent-dealer queue list     # position + wait reason for everything waiting
```

The response's `id` from `issue create` is the issue id used by every command below.

## 3. Confirm it's discoverable

```bash
agent-dealer issue list --status ready
```

## 4. Start it

```bash
agent-dealer issue start <issueId>
```

Start means "run this next": it moves the issue to the front of the admission queue and
admits it right away when a slot is free. There is no queue bypass — the response is either

```json
{ "state": "admitted", "instance": { "…": "…" }, "workItem": { "…": "…" } }
```

or, when the system is busy or the issue is not eligible yet,

```json
{ "state": "queued", "position": 1, "waitReason": "waiting for slot — running: Add widget" }
```

in which case it is the next issue admitted. A queued issue needs no second Start.

From here the coordinator's own timer-driven loop takes over: it launches the developer
worker in an isolated worktree with the snapshotted profile/deck, verifies and records
PR/SHA evidence, then launches the reviewer worker. No further action is needed until a
human action opens.

## 5. Watch it and find the pending action

```bash
agent-dealer issue show <issueId>       # poll .issue.status
agent-dealer action list                # find the open action for this issueId
```

`action list` includes each open action's `choices` (decoded from
`responseOptionsJson`) — never guess a valid choice string.

## 6. Resolve the action

```bash
agent-dealer action resolve <actionId> --choice complete --by <yourName>
```

An `approved` review opens a `final_review` action; `complete` finishes the workflow.
Other action types (`policy_escalation`, `attempts_exhausted`, `deck_interaction_required`,
`product_scope_decision`) surface their own valid choices the same way.

## 7. Confirm completion, with evidence

```bash
agent-dealer issue show <issueId> --include evidence
```

`evidence.workerSessions`, `evidence.artifacts`, and `evidence.usageEvents` cover every
developer/reviewer session, transcript/checks/PR artifact, and cost/token event for the
issue; `issue.prNumber` / `issue.prUrl` / `issue.headSha` carry the PR/SHA evidence.

## Known gaps filed separately

* `agent-dealer agent create` does not exist yet — an Agent Deck-bound profile must be
  created via the API/dashboard before step 1. Out of scope for NOT-79 (NOT-76 shipped
  discovery + `issue`/`action` commands only).
* A real dogfood run of this sequence against a live Agent Deck backend and a disposable
  target repo (not the fixture-based automated test) is tracked as a follow-up.
