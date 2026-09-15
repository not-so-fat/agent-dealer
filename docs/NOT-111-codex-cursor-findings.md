# NOT-111: Codex & Cursor usage-cap signal findings

Spike for runtime usage-cap detection outside Claude Code. Implemented where a reliable
hard-cap signal exists; otherwise the shared fallback cooldown path applies only when log
text matches cap-like errors (same heuristics as Claude result-without-event).

## Claude Code (`claude_code`)

**Reliable.** `--output-format stream-json` emits `rate_limit_event` with:

| Field | Example | Notes |
|-------|---------|-------|
| `rate_limit_info.status` | `"rejected"` | Hard cap when `"rejected"` (ignore `"allowed_warning"`) |
| `rate_limit_info.resetsAt` | `1784283600` | Unix **seconds** in current CLI output |
| `rate_limit_info.rateLimitType` | `"five_hour"` | Plan window type |
| `rate_limit_info.overageStatus` | `"rejected"` | Treat as hard cap when overage disabled |

Pinned fixture: `packages/server/src/runners/fixtures/claude-rate-limit-rejected.ndjson`

Session may also end with `result.is_error` and cap prose without a prior event — handled via
result-text heuristics + fallback cooldown.

## Codex (`codex_local`)

**Partial.** JSONL has no Claude-shaped `rate_limit_event`. Observed cap-like failures:

| Signal | Reliability | Implementation |
|--------|-------------|----------------|
| `turn.failed` with message matching rate/quota/limit | Medium | Implemented in `usage-cap.ts` |
| top-level `error` event with cap message | Medium | Implemented |
| stderr trailer after `--- stderr ---` | Low | Heuristic only |

Codex session rollouts may record `rate_limits` snapshots with `used_percent` (per OpenAI
Codex CLI docs/community) — not present in the normalized NDJSON stream agent-dealer
persists today. **No dedicated event type** comparable to Claude's `rate_limit_event`.

When JSONL is silent, we do **not** infer caps from exit code alone.

## Cursor (`cursor_local`)

**No dedicated cap event** (confirmed in `docs/INTEGRATION_POC_FINDINGS.md` — stream-json
has `system`, `thinking`, `assistant`, `tool_call`, `result` only; billing via dashboard).

| Signal | Reliability | Implementation |
|--------|-------------|----------------|
| `result.is_error` + cap-like text | Low | Shared heuristic |
| stderr / log pattern match | Low | Shared heuristic |

Same as Codex: no cap detection on exit code alone.

## Shared behavior

- One `runtime_availability` row per runtime (account-level).
- `runtimeAvailability(runtime)` exported from `coordinator/commands.ts` for NOT-103.
- Unknown reset → `USAGE_CAP_FALLBACK_COOLDOWN_MS` (default 30 min).
- Deferral ceiling → `USAGE_CAP_DEFERRAL_CEILING_MS` (default 24 h) → `policy_escalation`.
