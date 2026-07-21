# Manual run `external_id` — design

**Date:** 2026-07-21  
**Status:** approved  
**Incident:** Passport-skills feedback was attached to the Finperks lineage; investigation noted all `source=manual` runs had blank `external_id` / `external_label`, unlike Linear.

## One-liner

Manual creates mint a stable task id the same way Linear runs already carry one: set `external_id` at create and copy it on retry.

## Decision

On `createRun` when `source === "manual"` and no `externalId` is passed, set `external_id` to the new run’s `id`. Leave `external_label` null. Linear promote unchanged (`external_id` = issue UUID, `external_label` = identifier). Retry already copies both from the parent.

## Behavior

| | Linear | Manual (after) |
|---|---|---|
| `source` | `linear` | `manual` |
| `external_id` | Linear issue UUID | First run `id` |
| `external_label` | e.g. `ENG-123` | `null` |
| Retry / lineage | Copies from parent | Same (existing) |

Feedback on a run stays on that task: the review drawer / `POST /api/runs/:id/retry` already targets a run; the lineage shares one `external_id`.

## Code change

- **`packages/server/src/repository/runs.ts` — `createRun`:** after generating `id`, if `(opts?.source ?? "manual") === "manual"` and `opts?.externalId` is absent, set `external_id = id`.
- No `CreateRunInput` / API body changes.
- Linear path still passes `externalId` / `externalLabel` explicitly.

## Tests

- Manual create → `externalId === run.id`, `externalLabel === null`
- Retry of that run → child has the same `externalId`
- Linear promote (or create with `source: "linear"` + issue id) still uses the issue id, not the run id

## Non-goals

- UI topic-mismatch guard (“create new vs attach”)
- Slack thread `ts` as correlation key
- Backfill / cleanup of existing Finperks lineage data
- Executor prompt changes for off-topic feedback
- Setting `external_label` for manual runs
