# Runtime capacity (NOT-245)

Provider-neutral observed capacity for runtime accounts. Capacity belongs to
an authenticated runtime account, not an Agent profile: the Agents page and
`GET /api/runtime-capacity` report one entry per configured runtime, no matter
how many Agent profiles share it.

## Adapter interface

`packages/server/src/capacity/adapter.ts`. One adapter per provider surface:

```ts
interface CapacityAdapter {
  runtime: Runtime;
  source: "supported_protocol" | "observed_event" | "experimental_api";
  read(nowMs?: number): AdapterReadResult | Promise<AdapterReadResult>;
}
```

A read returns raw window readings plus unavailable readings:

- `AdapterWindowReading` — `windowKey` (stable per runtime, e.g.
  `weekly_all_models`), `providerBucket`, optional `durationMinutes`, the
  provider's own `providerLabel`, raw `usedValue`/`usedUnit`, and **one** used
  scale: `usedPercent` (0–100) or `usedFraction` (0–1). Optional `resetAt`,
  `observedAt`, `staleAfterMs`/`expiresAfterMs` overrides, and `evidenceRef`.
- `AdapterUnavailableReading` — same keys plus a machine-readable `reason`
  (`unsupported` | `missing` | `expired` | `unparsable` | `stale`).

Normalization (`normalizeAdapterWindow`) derives the snapshot:

- `displayLabel` from duration when defensible (300 min → `5H`,
  10,080 min → `1W`, ~30 d → `1M`, other exact hours/days → `NH`/`ND`);
  otherwise the provider label is kept verbatim — never guessed.
- `remainingPercent` as `clamp(100 - usedPercent, 0, 100)`; fractions are
  normalized to percent *before* the calculation. No usable scale →
  `unparsable`, `remainingPercent: null`.
- `freshUntil`/`expiresAt` default to observed + 15 min / + 60 min.

Provider live reads (auth, subprocess protocol) land in sibling tickets.
Until then, `fixtureMultiWindowAdapter` / `fixtureUnsupportedAdapter` /
`fixtureStaleAdapter` stand in deterministically. The first live provider is
Muse (NOT-247, `packages/server/src/capacity/muse.ts`) — see
"Provider: Muse Code" below; further providers land in sibling tickets.

## Freshness rules

| Condition | Rendered as |
|---|---|
| `remainingPercent` present, reset/expiry/freshness all future | remaining % |
| `resetAt` in the past (or unparsable reset) | N/A `expired` — a past reset is never current capacity |
| past `expiresAt` | N/A `expired` |
| past `freshUntil` but inside expiry | N/A `stale` |
| provider reports no surface | N/A `unsupported` |
| supported but nothing recorded yet | N/A `missing` |
| payload arrived but no usable scale | N/A `unparsable` |

Classification happens at read time in `capacity/service.ts`, so a snapshot
that ages out flips to N/A without a writer round-trip.

## API

`GET /api/runtime-capacity` → `RuntimeCapacityResponse`: every configured
runtime (distinct `agents.runtime` values plus any runtime holding snapshots),
its windows with freshness applied, and an explicit entry-level
`unavailableReason` when no window is current. Normalized snapshots only —
`evidence_ref` and raw provider payloads never leave the server.

## Persistence

`runtime_capacity_snapshots(runtime, window_key, …)` — one row per window, so
a provider can report several independently resetting windows per account.
Writes are per-window upserts; a partial re-observation never deletes a
still-valid sibling window. Independent of `runtime_availability` (NOT-111
hard caps): capacity snapshots neither read nor clear hard-cap rows, and
connection health stays a separate state — green health never implies known
capacity.

## Provider: Muse Code (NOT-247)

Sources: the Muse Code docs (`https://dev.meta.ai/docs/muse-code`) and the
subscriptions reference (`https://dev.meta.ai/docs/muse-code/subscriptions`).
The adapter speaks the versioned Session Protocol over a managed
`muse serve --protocol msp/1.3` subprocess: a single `usage/read` request,
then shutdown. `usage/changed` notifications received while the connection is
alive are recorded. The client enforces a read-only allowlist (`usage/read`)
— any other method throws before it is written, so polling can never start a
session, send a prompt, or consume model tokens. It is bounded (default 15 s
overall, `AGENT_DEALER_MUSE_CAPACITY_TIMEOUT_MS` override) and never billed.
No Keychain access, no undocumented endpoints.

Normalization keeps the two MSP 1.3 windows independently:

- `rolling` → window key `rolling_all_models` (`providerBucket`
  `all_models`), `windowDurationMins` → `durationMinutes` so the shared
  normalization derives the label (`300` → `5H`, `720` → `12H`, …) instead of
  hardcoding it; `usedPercent` and `resetsAtMs` pass through.
- `weekly` → window key `weekly_all_models` with the definitional
  `durationMinutes: 10080` (MSP 1.3 reports no weekly duration), `usedPercent`
  and `resetsAt` likewise.
- `observedAtMs` becomes the snapshot `observedAt`; `tier` is dropped at the
  adapter boundary — tier metadata beyond the runtime account context never
  persists and never reaches the browser.

Failure semantics (shared enum only, never thrown, never health rows):

| Serve outcome | N/A reason |
|---|---|
| `usage` omitted / empty, no credential, unauthenticated, spawn error, bad exit, timeout | `missing` |
| malformed payload | `unparsable` |
| binary unavailable (ENOENT) or server without the method (`-32601`) | `unsupported` |

A present-but-malformed sibling window becomes a per-window `unparsable`
reading rather than sinking the good window. The exact cause is logged
server-side as a static string; no credential, tier, or raw account payload
reaches the browser, the API, or the logs — evidence refs are static
(`muse-serve:usage/read`).

Refresh via `refreshMuseCapacityFromServe()` (bounded ingest through the
shared service path). Tests use the committed fake MSP server
(`packages/server/src/capacity/fixtures/fake-muse-serve.mjs`); CI performs no
live Muse request.
