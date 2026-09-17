# Troubleshooting

Operator recovery for agent-dealer runtime and host problems. Prefer `agent-dealer doctor` and the **Agents** health strip in the dashboard for live diagnosis; this page holds the longer recovery steps.

## Cursor macOS keychain auth

Long `cursor_local` sessions can die mid-run when macOS keychain refuses to update the Cursor access token (`errSecDuplicateItem`, security exit code 45). agent-dealer preflight treats that output as unhealthy (`cursor_keychain`) so Start / intake can refuse before a wasted run.

### Symptoms

- Agent health / Connections bar: Cursor amber with a keychain remediation message
- `agent-dealer doctor`: Cursor auth failure mentioning keychain
- Mid-session Cursor stderr (also classified when NOT-113 surfaces failure reasons):

```text
Cursor couldn't save your login to the macOS keychain (errSecDuplicateItem, security exit code 45).
The keychain item is stuck. Delete it and sign in again:
  security delete-generic-password -s cursor-access-token -a cursor-user
  agent login
```

### Recovery

1. Delete the stuck keychain item:

```bash
security delete-generic-password -s cursor-access-token -a cursor-user
```

2. Sign in again (either form is fine):

```bash
agent login
# or:
cursor-agent login
```

3. Confirm:

```bash
agent-dealer doctor
# Agents page / Connections: Cursor should show ready again
```

If delete reports the item was not found, still run `agent login` / `cursor-agent login` and re-check doctor.

Related: NOT-103 (session death → dirty worktree), NOT-114 (this preflight + docs), NOT-113 (post-failure reason surfacing).

## Runtime not logged in (NOT-133)

A runtime CLI that is simply logged out is a different failure from the keychain one above, and for a while it was an *invisible* one: the classifier's pattern list never covered what `cursor-agent` actually prints, so twelve sessions across three issues spawned, died in about a second each, and were reported as `Developer session failed or crashed.`

Health issue code is `runtime_auth` for all three runtimes. What each CLI prints when logged out (verbatim captures live in `packages/shared/src/fixtures/runtime-auth/`):

```text
# cursor-agent -p …
Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.

# cursor-agent status   (exits 0 — the text is the only signal)
Not logged in

# codex exec …
ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header

# claude -p …
Not logged in · Please run /login
```

### Recovery

```bash
cursor-agent login   # or: agent login, or export CURSOR_API_KEY=…
codex login          # or: export OPENAI_API_KEY=…
claude auth login    # or `/login` in a session, or export ANTHROPIC_API_KEY=…
```

Then `agent-dealer doctor`, or just let the queue re-evaluate — an issue whose agent fails this preflight **waits in the queue with the auth message as its wait reason** rather than being admitted. It does not spend infra attempts and does not park on a human.

Two related notes:

- `cursor-agent status` failing for an unclassifiable reason (non-zero exit, timeout) is also reported as `runtime_auth`, worded "Could not confirm Cursor auth". Silence is not evidence of health, and waiting a tick is cheaper than a burnt round.
- Bedrock/Vertex Claude installs (`CLAUDE_CODE_USE_BEDROCK=1` / `CLAUDE_CODE_USE_VERTEX=1`) authenticate through AWS/GCP, so the `claude auth status` preflight is skipped for them.

Whenever a runtime reworded one of these strings, add its capture to `packages/shared/src/fixtures/runtime-auth/` and extend `runtime-auth-health.ts` — never a phrasing typed from memory. That is the exact mistake NOT-133 was.

Related: NOT-114 (keychain branch), NOT-113 (failure strip), NOT-128 (runtime-auth failures should not spend developer attempts).

## Coordinator lease / heartbeat (NOT-113)

| Env | Default | Role |
| --- | --- | --- |
| `COORDINATOR_HEARTBEAT_MS` | `15000` | How often the effect worker refreshes the work-item lease and session heartbeat while `await`ing the agent spawn. |
| `COORDINATOR_LEASE_MS` | `60000` | How long a lease stays valid without a refresh. Recovery reclaims expired leases as “worker process presumed dead”. |

### Decision (keep defaults)

Investigated against long `cursor_local` runs and the NOT-103 “presumed dead” / dirty-tree incidents:

1. **Heartbeats do not stop while Cursor is alive.** They run on a `setInterval` in the coordinator Node process, in parallel with `await spawn(...)`. A healthy long Cursor session keeps refreshing the lease for the whole spawn.
2. **60s is not “too short for Cursor thinking.”** Lease expiry means the **coordinator worker process** stopped heartbeating (crash, kill, blocked event loop for > lease). It is not a Cursor-child liveness probe. Cursor wall-clock is `sessionTimeoutMs`, separate from the lease.
3. **Lease ≈ 4× heartbeat** is intentional: a few missed ticks can be transient; a full lease window without refresh means the Node worker is gone. Moving heartbeats “off the blocked path” is unnecessary today — spawn I/O is async; do not raise the lease without evidence of multi-minute event-loop stalls.
4. **Observed “presumed dead” on NOT-103** matched coordinator/process recovery after the worker disappeared, not a live Cursor session whose heartbeats were starved by agent think time. Opaque UI was the gap (fixed by failure reasons), not the cadence.

### Override guidance

- Raise `COORDINATOR_LEASE_MS` (and keep heartbeat ≤ ~¼ of lease) only if you have logs showing lease reclaim while the same Node PID was still running the effect and Cursor was healthy.
- Lower values only for faster crash recovery in labs; too-low leases amplify false “presumed dead” under GC pauses.
- Failure reasons on the issue timeline / detail strip are the operator-facing fix for mid-run Cursor auth death; do not conflate that with lease tuning.

### Host sleep is not a crash (NOT-124 / NOT-125)

The reasoning above holds for a *running* host. It does not hold for one that sleeps: the
heartbeat is a `setInterval`, and timers do not fire while a laptop is suspended, but
wall-clock time keeps advancing. Every wake therefore looked exactly like a crash. On
2026-09-15/16 that failed six healthy developer sessions — one of which had already pushed
its branch and opened its PR — with `worker process presumed dead`, each failure landing on
a macOS wake to the second.

Two gates now stand between an expired lease and a reclaim. Neither can *cause* a reclaim,
and neither replaces the lease-token CAS that fences the write itself:

| Gate | Evidence | What it covers |
| --- | --- | --- |
| Process liveness | `worker_sessions.process_pid` + `process_owner`, checked with `kill(pid, 0)` | The spawned CLI is verifiably still running, so the lease is extended instead of reclaimed. |
| Clock-jump grace | the gap between two poll ticks, measured both against `performance.now()` and against the poll interval itself | The host was suspended, so leases that predate the jump get one `COORDINATOR_LEASE_MS` grace window before they are eligible. |

The pid is only trusted while `process_owner` names the *running* coordinator process. After
a restart (or on another host) it is discarded rather than believed: the OS recycles pids, so
a stale row could otherwise match some unrelated program forever and strand the work item —
a permanent stall, strictly worse than the over-eager reclaim being fixed. With no usable
pid, reclaim falls back to the timestamp-only behaviour NOT-116 shipped.

| Env | Default | Role |
| --- | --- | --- |
| `COORDINATOR_CLOCK_JUMP_THRESHOLD_MS` | `max(COORDINATOR_POLL_INTERVAL_MS × 2, 5000)` | How large a tick gap counts as a host suspension rather than scheduling noise. |

Two signals feed that threshold, and a jump is declared when **either** trips. The
wall-clock-minus-monotonic delta is the textbook one, but it silently reads zero wherever
libuv's monotonic clock is `mach_continuous_time()` — which keeps counting while the machine
sleeps. So the gap between poll ticks is measured too: a 3s timer that took 49 minutes to
fire did not fire, and the heartbeats that would have renewed those leases did not run
either, whatever any clock says.

**Reading the logs.** An absorbed sleep is deliberately distinct from a real presumed-dead
reclaim:

- `[coordinator] host clock jumped 2940s (2939s un-elapsed) — likely host sleep` — the host slept.
- `[coordinator] clock jump absorbed — holding N lease(s) that predate it` — those N items were spared.
- `[coordinator] lease expired but worker pid NNN is alive — extending` — that CLI is still running.

Seeing `worker process presumed dead` *without* any of the above still means what it always
meant: the worker really was gone.

### A reclaim republishes the branch, it does not always redo the work (NOT-129)

The gates above reduce *wrong* reclaims; they do not change what a *right* one costs. That
used to be everything: a reclaim requeued a full developer session regardless of what the
dead attempt had already produced. On NOT-121 a commit (`959f098`) sat unpushed on the branch
for roughly three hours while five further agent sessions each re-ran a ~40-minute suite to
redo it — and throughout that window the PR was `OPEN` and `MERGEABLE` carrying only half the
fix, so merging it would have silently shipped a partial change.

The branch, not the session, is the durable artifact. A presumed-dead reclaim now inspects it
first (locally — no network call per expired lease) and picks one of three routes:

| Branch state | Route | Cost |
| --- | --- | --- |
| Commits past base that origin does not have | `publishOnly` work item — push + PR + checks | no agent session |
| Commits already on origin | `publishOnly` work item — PR identity + checks re-verified | no agent session |
| No branch, no commits past base, or no base to measure against | normal developer attempt | a full agent session |

Both no-agent routes reuse the existing publish path (`developer-effect.ts`'s
`runPublishOnlyHandoff`), the same one a post-push `adapter_failure` retry takes.

**Telling the two apart.** The `worker.failed` timeline payload carries `recovery`
(`"republish"` / `"rerun"`) plus `branchState`, and its prose reason spells the choice out
after the usual `presumed dead` prefix — e.g. `republishing 1 unpushed commit on issue-…
instead of re-running the developer`. In the logs:

- `[coordinator] N reclaim(s) routed to republish — branch already had commits, no new agent session`

A republish never force-pushes and never discards: a branch that has fallen *behind* origin is
left alone (origin is the better artifact), and a rejected push surfaces as the same
`unpushed_commit` policy escalation a live attempt's rejected push gets.

## "Waiting for Agent Deck" — a deck outage is a wait, not a failed attempt (NOT-136)

Every deck-bound session preflights Agent Deck (`get_bound_deck` + every configured
playbook) before it spawns. That preflight used to have one failure mode, so a deck that was
merely *restarting* looked identical to a deck that had rejected the session. On 2026-09-16
that cost a healthy round its entire infra budget in nine seconds: four reviewer attempts at
`12:01:55`–`12:02:04`, all `preflight failed: fetch failed`, none with a pid or a log path —
nothing ever spawned — and the issue parked on a human for a condition that fixed itself when
the deck came back.

Preflight now distinguishes two outcomes:

| Outcome | What it means | Cost |
| --- | --- | --- |
| `deck_unavailable` | Nothing answered — connection refused, DNS failure, or the preflight budget elapsed with no reply | **no** infra attempt, no review round; the work item is deferred and re-tried automatically |
| `deck_failure` | The deck answered and the answer was wrong — HTTP error, `isError` tool result, wrong bound deck, missing playbook | unchanged: a bounded infra retry, then `policy_escalation` |

Only transport-level death classifies as unavailable, so a reachable-but-broken deck still
fails loudly. Two independent guards keep that true:

- **Where the error came from.** Only an error thrown out of an awaited preflight call can be
  unavailable. A deck that is up can report its own proxied service as down (NOT-101) with the
  literal text `fetch failed` in an `isError` result — judging an answer we received is never
  a wait.
- **Whether anything answered over HTTP.** The MCP SDK reports a non-2xx response by throwing
  `StreamableHTTPError(status, "Error POSTing to endpoint: <body>")`, pasting the response body
  into the message — so an HTTP 500 whose body reads `fetch failed` would otherwise look like a
  dead port. An HTTP status anywhere in the error chain is proof that bytes came back, and it
  overrides every message heuristic.

The deferral reuses the NOT-111 usage-cap path (`deferWorkItem` + `revertAttemptCount`), so
the claim-time `attempt_count` bump is undone too.

**Reading it.** The issue stays in `developing` / `reviewing` with the live intent
`Waiting for Agent Deck — …`, and the timeline shows `Waiting for Agent Deck (round N)`
(a `worker.deferred` event with `outcome: "deck_unavailable"`), not a worker failure. No
human action is created and none is needed — start the deck and the next retry proceeds.

Unlike a usage cap, an outage has **no deferral ceiling and never escalates**: the item keeps
re-preflighting on the capped backoff for as long as the deck is down, because handing it to a
human would freeze an issue the deck's return would otherwise unblock by itself. Once the wait
passes `DECK_OUTAGE_PROLONGED_AFTER_MS` the intent starts naming its length
(`Waiting for Agent Deck — … (unreachable for 3h) (retrying 14:05)`), so a long outage is
visible without being terminal.

| Env | Default | Role |
| --- | --- | --- |
| `DECK_OUTAGE_BACKOFF_BASE_MS` | `15000` | Wait before the first re-preflight. |
| `DECK_OUTAGE_BACKOFF_MAX_MS` | `600000` | Ceiling on the doubling backoff, so a long outage re-probes every 10 minutes rather than in a tight loop. |
| `DECK_OUTAGE_PROLONGED_AFTER_MS` | `900000` | When the live intent starts reporting how long the deck has been unreachable. Display only — it does not stop the retries. |

If an issue *is* waiting and the deck is up, check that the deck the agent profile names is
the one being served: a deck that answers but reports a different `id` is a `deck_failure`,
not a wait, and will show as a worker failure with the mismatched id in its reason.
