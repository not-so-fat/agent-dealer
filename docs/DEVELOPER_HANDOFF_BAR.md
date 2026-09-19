# Developer handoff bar (NOT-146)

## Timed developer spawn

A **clean developer handoff** (`clean_handoff` → reviewer) is valid when:

1. The issue branch has commits ahead of base, and
2. The worktree is clean, and
3. The agent ran **targeted tests** for the change (prompt contract).

The coordinator verifies (1)–(2) plus push / draft-PR identity / GitHub checks polling. It does **not** require a full local suite green receipt or a Lens pass inside the same timed developer spawn.

## Full suite / Lens (NOT-74)

Full suite and Lens self-review stay product quality gates, but they live on a **separate budget** from the implement wall clock (default `DEVELOPER_TIMEOUT_MS`). Placement:

| Stage | Budget | Gate |
|-------|--------|------|
| Developer timed spawn | Implement + targeted tests | Commits + clean tip + publish |
| Lens / full-suite verify | Separate work item or reviewer path (NOT-74) | Recorded Lens / suite evidence |

NOT-74 remains the ticket that hard-gates handoff on Lens evidence; until it lands, prompt + docs make the implement vs verify split explicit so agents do not burn the 60m coding budget on full suite + Lens.

## Regression

`developer-effect` clean-handoff tests must keep succeeding without a `verification_receipt` artifact (no full-suite evidence required for handoff).
