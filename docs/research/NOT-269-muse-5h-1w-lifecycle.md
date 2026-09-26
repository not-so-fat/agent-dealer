# NOT-269: Muse 5H/1W acquisition lifecycle — evidence and recommendation

Parent: NOT-265. Bounded research slice; production adapter (`packages/server/src/capacity/muse.ts`,
`/api/runtime-capacity`, polling) is intentionally unchanged in this ticket.

## Tested version

- `muse --version` → `Muse Code 1.4.0 (1.4.0-R4161.1)`
- Stable schema exported offline: `muse schema generate-json-schema --out <dir>`
  (no `--experimental` flag). Manifest fingerprint
  `sha256:36466f634c8c78a812462ec941187fd4547b232ee06153e5feb2a1482f0d3d7f`,
  bundle 254,510 bytes, sha256 `d05cbf1a…cbe4d6af`.
- Docs checked: subscriptions reference and changelog URLs from the ticket brief
  (schema text below is the authoritative local evidence).

## Exact protocol messages (stable schema, verbatim descriptions)

- `usage/read` — "Reads the host's last-observed subscription usage window
  (5h-class and weekly percent blocks, tier, arrival stamp) without a model
  call; the usage member is omitted when nothing has been observed (ADR 32563 D2)."
- `UsageReadResult` — "`usage/read` result: `{usage?}` — omitted, never `null`,
  when the host has observed nothing (ADR 32563 D2: truthful absence …)."
- `usage/changed` — "The host's last-observed subscription usage DATA changed
  (window, weekly, or tier — not a stamp-only refresh) … the absent-to-present
  first observation emits (ADR 32563 D3)."
- `SubscriptionUsage` requires exactly `observedAtMs`, `tier`, `weekly`, `window`.
  `window` requires `resetsAtMs`, `usedPercent`, `windowDurationMins` (integers,
  percent ≥ 0 verbatim, over-100 valid — the 5h-class block). `weekly` requires
  `resetsAtMs`, `usedPercent` (no duration — Dealer already treats it as 10080 min).

## Sanitized shapes (key names and types only — no values captured)

`usage/read` result when observed:

```
{ "usage": {
    "observedAtMs": "<epoch-ms arrival stamp>",
    "tier": "<redacted-string>",
    "window": { "usedPercent": "<integer>", "resetsAtMs": "<epoch-ms>",
                 "windowDurationMins": "<integer>" },
    "weekly": { "usedPercent": "<integer>", "resetsAtMs": "<epoch-ms>" } } }
```

`usage/read` result when the host observed nothing: `{}` (or `{protocol}`
envelope) — `usage` omitted, never null. `usage/changed` params carry the same
`SubscriptionUsage` object (not wrapped in `{usage}`).

## Answers (observed vs blocked — stated plainly)

1. **Long-lived host + real session on that same host? — NOT directly observed
   (blocked, see boundaries), but the schema proves the mechanism.** First
   provider traffic on a host emits `usage/changed` (absent-to-present counts as
   a change, D3); afterwards `usage/read` returns both `window` and `weekly`
   (both are `required` in `SubscriptionUsage`, so a conforming observation
   always carries the full 5H + 1W pair). Live confirmation needs an
   authenticated host plus one real meta-provider turn; this spawn has Keychain
   code -50 isolation (below) and manufacturing a paid turn is a non-goal.
2. **`session/resume` without a prompt? — No, by schema.** `SessionResumeResult`
   is `{history, pendingRequests, session, viewCursor}` — no `usage` member, so
   a resume cannot return quota in-band. It is non-billable (no turn/model call
   in the method), but it is state-changing (writes a durable `SessionResumed`
   record, auto-subscribes the connection) and already on the adapter's
   forbidden list — never use it as a refresh path.
3. **Any stable `muse exec --json` event with the usage payload? — No.**
   `SubscriptionUsage` is `$ref`'d from exactly two schema locations:
   `usage/read` result and `usage/changed` params. `session/tokenUsage` is
   per-call token counters; `session/contextUsage` is the context-pressure
   triple — neither is quota. Dealer's own exec parser (`muse-code-jsonl.ts`)
   knows the same taxonomy (token usage, terminals, task lifecycle, 429 facets
   carrying booleans, never percents). Negative controls run this session: a
   free `--provider echo` exec emitted 27 durable-record frames with zero
   subscription-usage keys (echo makes no provider traffic, as expected), and
   two real on-disk completed session logs (979 + 53 records plus subagent
   logs) contain zero `usedPercent`/`resetsAtMs`/`observedAtMs`/`window`/`weekly`
   keys — their `usage` members are token counters and resource stats only.
4. **Process-local, persisted, or resumable? — Process-local.** Session logs
   persist no subscription observation (scans above); the schema calls it the
   "host's last-observed" with a "frame arrival" stamp. A restarted host has
   observed nothing, so `usage/read` returns `usage` omitted until that host
   sees fresh provider traffic. Persistence is rejected, not merely unproven.
5. **Smallest supported no-cost integration? — See recommendation.** No method
   returns quota without prior provider traffic on the same host, and no exec
   event substitutes for it.

## Probe matrix record

| Probe | Result |
|---|---|
| Fresh host → initialize → initialized → usage/read | Reproduced the failure mode: in a spawn without Keychain access the host exits 3 (`keychain item for meta is unreadable (os status -50)`), empty stdout, `initialize` unanswered → adapter `missing`. With working auth the ticket premise holds: `usage` omitted → `missing` (never throws, never a synthetic call). |
| Same host → real session → usage/changed → usage/read (window + weekly) | Blocked live (no authenticated host + no paid synthetic turn); mechanism proven by schema (D3 first-observation emit; both members `required`). |
| Fresh host → resume existing completed session, no prompt | No in-band usage per `SessionResumeResult` shape; state-changing; forbidden for refresh. Two completed sessions exist on disk but no authenticated host could resume them. |
| Existing `exec --json` logs → typed usage-event search | Done: zero subscription-usage keys in 979 + 53 real session records and 27 echo-exec frames. |
| Host restart after observation | Persistence rejected by (3)+(4): observations live in host memory only; a new host starts unobserved. |

Rerun harness: `scripts/muse-capacity-lifecycle-probe.mjs` (sanitized output,
read-only except one optional free `--provider echo` control; live MSP legs
skip honestly when the host cannot authenticate). Deterministic contract test:
`packages/server/src/capacity/muse-lifecycle.test.ts` (fake host + redacted
shapes, no account data).

## Boundaries

- **Ownership:** one long-lived `muse serve` host per Muse account, owned by the
  server process (started at boot/first demand, held open). Concurrent one-shot
  hosts each hold independent empty observations — never fan out per poll.
- **Restart:** state is lost; after restart `usage/read` → omitted → `missing`
  until the next real turn on that host. Never backfill from another host.
- **Concurrency/timeout:** readers share the one host connection (single-flight
  `usage/read`); keep the 15 s bound. A read on an observed host answers
  instantly with no model call — never billed.
- **Credentials:** the host uses its ambient login (refresh token in macOS
  Keychain; `auth.json` is only the pointer). No key is ever passed, read, or
  logged. Spawn contexts without Keychain access (sandboxed workers, this
  probe's context) fail at startup (exit 3) → `missing`, not an error row.
  `XDG_CONFIG_HOME` redirection changes which `auth.json` is used — the
  capacity host must run with the same config home as the runner.
- **Structural precondition (found, not fixed here):** Dealer runs Muse turns
  as `muse exec` subprocesses (`muse-code-args.ts`), never through a serve
  host — so a capacity-only serve host would observe nothing forever. The
  recommendation below accepts this consequence.

## Recommendation (one implementable path, user contract preserved)

Route Dealer's real Muse turns through the server-owned serve host, then read
quota from that same host. Exact MSP order on the owned host:

```
initialize {clientInfo:{name:"agent_dealer",version:"<server>"}}
→ initialized (notification; hold the connection open for process lifetime)
→ (passive) record usage/changed   [arrives after real turns only]
→ usage/read                        [on demand, throttled; both window+weekly required]
→ never: session/resume-as-refresh, second usage/read per poll, per-poll spawn
```

Ownership: server singleton per account; the runner's real `session/start` +
`turn/start` traffic MUST flow through this host (otherwise it stays
unobserved by construction). No synthetic/polling turn is ever sent — only
genuine Dealer work populates usage, so reads stay free. Muse primary capacity
stays exactly 5H + 1W (`window` → `rolling_all_models`/5H-class label derived
from `windowDurationMins`, `weekly` → `weekly_all_models`/1W); a host that has
not yet observed reads `missing` (N/A), never a fabricated pair.

**If the runner migration is rejected, the honest alternative is: supported
no-cost acquisition is unavailable** with the current exec-based runner — keep
the one-shot `usage/read` (which can only ever return `missing`) or remove it,
and do not ship a paid/synthetic probe. Either way the NOT-247 child contract
must change: delete the "one-shot serve answers usage/read" assumption and
replace it with the owned-host precondition above.

## Contract delta for the blocked implementation ticket (NOT-247 child)

- One-shot `muse serve` + `usage/read` cannot refresh capacity (fresh host is
  structurally unobserved; verified against 1.4.0 schema + scans).
- `session/resume` is not a refresh path (no usage in result; state-changing).
- No `exec --json` event carries quota (schema refs + log scans).
- Implementable path requires the runner to send real turns through the owned
  long-lived host (precondition), or conclude no-cost acquisition unavailable.
