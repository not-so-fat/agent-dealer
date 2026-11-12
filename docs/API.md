# Dealer API reference: guidance and human-action resolution (NOT-575)

The two operator-facing writes the dashboard, the CLI, and coding agents use
to steer a running issue. Payload shapes are validated at runtime: a wrong
type answers `400`, never `500`.

Base URL is the local Dealer API (default `http://127.0.0.1:2222`).

## POST /api/issues/:id/guidance — append guidance for the next worker

```json
{ "markdown": "Prefer the existing retry helper over a new one." }
```

| Field      | Required | Shape                                    |
|------------|----------|------------------------------------------|
| `markdown` | yes      | Non-blank string; blank answers `400`    |

Appends a `guidance.added` timeline event carrying `{ "markdown": ... }`.
Unknown issue id answers `404`.

Semantics: guidance reaches the next worker session's prompt (developer or
reviewer), not a running one — every round is a fresh process, so text posted
while a session is already dispatched waits for the session after it. Send
guidance as often as needed; each event is shown exactly once.

CLI equivalent: `agent-dealer issue guide <issueId> --message "..."`.

## POST /api/human-actions/:id/resolve — resolve an open action

```json
{ "resolvedBy": "op", "choice": "verified", "note": "SSO login OK — dashboard shown." }
```

| Field        | Required | Shape                                                                 |
|--------------|----------|-----------------------------------------------------------------------|
| `resolvedBy` | yes      | Non-blank string naming the actor; recorded on the action and events |
| `choice`     | yes      | Non-blank string; must be valid for the action type (table below)    |
| `note`       | varies   | String up to 4000 chars; see per-type rules below                    |

Validation: missing/blank `resolvedBy` or `choice` answers `400`; a present
but non-string `note` answers `400`; a `note` over 4000 chars answers `400`.
Unknown action id answers `404`; an already-resolved action answers `409`;
an invalid `choice` for the action type answers `400` naming the action type.

Success answers `{ "issueStatus", "nextWorkItemId", "instanceCompleted",
"restarted" }`, except the two control-plane parks below.

CLI equivalent: `agent-dealer action resolve <actionId> --choice <choice>
--by <name> [--note "..."]`.

### Discovering the valid choices: responseOptionsJson

Never guess a `choice` string. Every open action stores its own
`responseOptionsJson` — `[{ "choice", "label" }, ...]` — and `agent-dealer
action list` surfaces it decoded as `choices`. That stored list is the source
of truth for the action in front of you; the table below documents what each
action type can carry so resolvers know what to expect before they fetch.

(Legacy rows may store `responseOptionsJson: null`; the server still
validates against the same per-type lists, so an unknown option is a `400`
with the action type named, never a silent mis-resolve.)

### Valid choices per action type

| Action type | Valid `choice` values | `note` | Outcome |
|-------------|----------------------|--------|---------|
| `final_review` | `merge`, `repair`, `close` (`complete` accepted as a legacy synonym for `merge`) | dropped (not stored, not threaded) | `merge` undrafts and merges the PR, then `done`; `repair` queues a developer round; `close` finishes `closed` |
| `attempts_exhausted` | `retry`, `close` | dropped | `retry` grants one more review round and queues a developer round; `close` finishes `closed` |
| `policy_escalation` (default) | `resume`, `close` | dropped | `resume` queues a fresh attempt without spending a review round; `close` finishes `closed` |
| `policy_escalation` (merge failure, evidence `mergeFailure: true`) | `retry_merge`, `repair`, `close` | dropped | `retry_merge` parks for undraft+merge on the current head; `repair` queues a developer round; `close` finishes `closed` |
| `policy_escalation` (diverged push, evidence `pushDivergence`) | `push_with_lease`, `resume`, `close` | dropped | `push_with_lease` publishes the finished commits under the stored lease pin (async resolver only); `resume`/`close` as default |
| `policy_escalation` (Linear post-merge notice) | `acknowledge`, `recheck` (legacy `close`/`dismiss` still accepted) | dropped | `acknowledge` closes the notice; `recheck` closes it and re-runs the post-merge verification |
| `product_scope_decision` | `resume` | optional, threaded verbatim into the very next developer round's prompt | `resume` unblocks the paused workflow without spending a round |
| `deck_interaction_required` | `resume`, `close` | dropped | `resume` retries with a freshly minted authority; `close` finishes `closed` |
| `reflection_interaction_required` | `retry`, `dismiss` | dropped | Control-plane park on an already-`done` issue: `retry` re-attempts the reflection read/propose, `dismiss` drops it. Never reopens the issue or enqueues worker rounds |
| `outbound_delivery_interaction_required` | `retry_send`, `reject` | dropped | Run-scoped (no issue/workflow): `retry_send` retries the approved draft's delivery, `reject` drops it. Answers `{ "runStatus", "delivered" }` instead of the issue shape |
| `muse_capability` | `acknowledge` | dropped | Records a per-version capability override for a `missing` verdict (lifts the admission block); dismisses an `unverified` one. No workflow change |
| `operator_verification` | `verified`, `waive`, `repair` | **required**, non-blank: the pasted result (`verified`), the waiver reason (`waive`), or what the next round must fix (`repair`) | `verified`/`waive` record the head-pinned result and park for undraft+merge; `repair` queues a developer round with the note threaded to its prompt |

Notes on the table:

- `note` is validated for every action type (string, at most 4000 chars) but
  only `product_scope_decision` and `operator_verification` keep it; every
  other type drops it at parse time. Only `operator_verification` requires
  it — resolving without one answers `400`.
- `final_review:merge`, `policy_escalation:retry_merge`, and
  `operator_verification:verified`/`waive` all park for the same
  undraft+merge finalize, which re-checks its gates (including the operator
  gate) against the then-current head before merging — new commits re-block.
- `push_with_lease` runs `git` before anything resolves, so it only
  completes through the async resolver; the sync entry point answers `409`
  telling the caller to use it.
- A `close` on an issue whose PR is merged on GitHub lands as `done` (the
  code is on the base branch), not `closed`.
