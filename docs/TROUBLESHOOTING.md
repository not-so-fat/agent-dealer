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
