# NOT-254: How Dealer should react to a muse_code session stuck retrying a degraded provider

Decision: **Option 3 — surface only; no restart, no timeout-accounting change.**
Revisit when the signal below fires. No production runtime behavior changes in this ticket.

## Evidence

### The incident (NOT-224 pull, 2026-09-21, session `4946f385-…`)

33 model turns in a 60-minute developer session; 17 turns retried (39 retry
events: 16 × HTTP 503 at fixed 60 s backoff, 23 transport errors at 1–32 s).
Scheduled backoff alone ≈ 17.65 min. Retried turns consumed 49.5 of 60 min.
`worker_sessions.heartbeat_at` advanced tick-by-tick through the backoff, so
the coordinator saw "alive" throughout. The session timed out and the cold
retry re-implemented from scratch (companion ticket's defect, not this one).

### Refresh (2026-09-22, same machine, same method)

125 `muse_code` sessions with a full raw log, 7,082 model turns
(definition: distinct `task_id`s with `task.lifecycle.status` events;
a turn counts as retried with ≥ 1 `retrying meta model stream …` status —
reproduces the incident's 17 turns / 39 events exactly):

- 71/7,082 turns retried (**≈ 1.0 %** — same rate as the original 52/4,498).
- 92/125 sessions have zero retries (was 44/68).
- 503s remain rare and concentrated: 30 events across 6 sessions;
  the incident session holds 16 of them.
- **Second degraded session found: `25bbe007-…`** (2026-09-22, developer,
  48 turns, 6 retried, 12 retry events, 5 × 503, one turn reaching attempt
  8/10 at 60 s backoff). Outcome per `dealer.db`: **`done`** — it rode out
  the degraded window and finished. The incident session (`4946f385-…`)
  is `timed_out`.
- Only 3/125 sessions ever reach attempt ≥ 5/10 on any turn; only 8/125
  have ≥ 3 retried turns. The incident session is still the extreme outlier
  by roughly 3× on every axis.

So n is now 2 for "heavily retrying session", with opposite outcomes:
one died of backoff-consumed budget, one self-recovered and completed.

### What Dealer can see today

- The muse parser (`packages/server/src/runners/muse-code-jsonl.ts`) tracks
  only 429/`rate_limited` facets. 503 and transport-error retries from the
  session log are invisible to Dealer mid-run.
- Post-hoc observability exists (NOT-173/NOT-174: execution phases, silence
  intervals, attempt waste in Issue Detail + APIs), but nothing live:
  heartbeat advances during backoff, so "retrying" and "progressing" are
  indistinguishable to the coordinator.

## Option analysis

1. **Restart on degraded (N consecutive / M-of-last-K retried turns).**
   Against: the n=1 "fresh session lands healthier" story is now n=1-for,
   n=1-against — `25bbe007-…` recovered without a restart, and any trigger
   sensitive enough to have caught `4946f385-…` early would likely also have
   fired on `25bbe007-…`, discarding live progress to fix a transient.
   A restart also cannot distinguish a bad connection (fresh session helps)
   from a struggling backend (fresh session re-hits it); we have no provider
   visibility. Rejected for now.
2. **Stop counting provider backoff against the session timeout.**
   Principled (the budget should measure agent progress), but Dealer cannot
   measure backoff yet (see above), and it risks masking genuinely stuck
   sessions behind "provider is slow". Only 1/125 sessions would have
   benefited. Deferred until detection exists and the base rate justifies it.
3. **Surface only (extend NOT-174 observability to live degraded-backoff state).**
   Cheap, reversible, and produces exactly the dataset options 1–2 need:
   per-session retried-turn counts, backoff minutes, and outcomes, recorded
   uniformly instead of via one-off log forensics. Chosen.
4. **Do nothing at all.** Rejected: the incident cost a full 60-minute
   session with zero salvageable signal mid-run; recording the signal live
   is low-cost and purely additive.

## Follow-on scope (not implemented here)

File as one ticket: *Surface live provider-backoff state for running
`muse_code` sessions.* Suggested shape (assignee to confirm):

- Signal: tail the session log during the run for
  `task.lifecycle.status` with `message` matching
  `retrying meta model stream in <ms>ms (attempt N/10)`; expose per-session
  `retriedTurns`, `retryEvents`, `backoffMsScheduled`, `lastRetryAt`.
- Display: a degraded badge/row on the running session (Issue Detail live
  section), reusing NOT-174's quality/coverage conventions; no routing,
  retry, or timeout decision may read it.
- Config (observation only, safe defaults): `DEALER_RETRY_SIGNAL_TAIL_LINES`
  (default 200), `DEALER_RETRY_SIGNAL_POLL_MS` (default 15000).
- Explicit non-goals: no restart, no timeout exclusion, no CLI changes.

## Signal that would change this decision

- A **second** session that times out (or spends > 50 % of its budget in
  scheduled backoff) with retry-backoff as the attributable cause, or
- evidence that restarts systematically help (restarted sessions showing
  fewer retries than continued degraded ones), or
- 503/transport retries rising sustainably above the current ~1 % turn base
  rate across a week of sessions.

Any of these re-opens option 1 (with trigger thresholds set from the
recorded distribution, e.g. consecutive-retried-turns ≥ the 99th percentile
of completed sessions) or option 2 (backoff-exclusion once the signal above
exists to measure it). Linear ticket ids for NOT-224/NOT-198/NOT-174 could
not be looked up from this session; links in the task brief are taken as
given.
