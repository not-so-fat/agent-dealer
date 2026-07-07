# Plan questions, self-triage auto-approve, and spawned-run hygiene

**Date:** 2026-07-07 · **Status:** Superseded by [`docs/PRD_PLAN_QUESTIONS.md`](../../PRD_PLAN_QUESTIONS.md) — implement from the PRD, not this draft

## Problem

The plan phase is a one-shot headless `claude -p` call. The agent has no way to ask
the human anything: clarifying questions end up buried as prose inside the draft plan
markdown, easy to miss in the dashboard. Separately, every task — however trivial —
waits on human plan review, which is the real friction (the plan draft itself is cheap
and automatic). Finally, the user-global superpowers plugin injects ~2k tokens of
skill instructions into every spawned run while the `Skill` tool is not allowlisted,
so runs pay context cost for capability they cannot use.

## Decisions (agreed with user)

1. **Structured answers go straight to execution.** No plan revision round; answers are
   injected into the execution prompt. Free-form answers trigger a plan redraft instead.
2. **Agent self-triage decides "lightweight".** The plan agent, which already inspects
   the repo, emits a verdict; `trivial` plans auto-approve. No human toggle, no separate
   classifier call.
3. **Result review is the only guardrail** for auto-approved runs. Existing budget caps,
   tool allowlist, and workspace scoping contain the blast radius; the human still gates
   "done".
4. **Approach A — output contract** on the existing headless call. No Agent SDK
   rearchitecture; the artifact/UI/gate design keeps a migration path to interactive
   (SDK `canUseTool`) planning later.
5. **Spawned runs can use superpowers.** Plugins already load into spawned `claude -p`
   sessions; make that capability real by allowlisting the `Skill` tool in every phase
   instead of paying the context cost for nothing.

## 1. Plan output contract

`buildPlanPrompt` (packages/server/src/runners/prompts.ts) instructs the agent to end
its reply with a fenced ```json block after the plan markdown:

```json
{
  "verdict": "trivial" | "needs_review",
  "rationale": "one sentence — why this verdict",
  "questions": [
    {
      "id": "q1",
      "question": "Should the retry endpoint reuse the parent budget?",
      "options": [
        { "label": "Reuse parent", "description": "…" },
        { "label": "Fresh default", "description": "…" }
      ]
    }
  ]
}
```

Prompt rules:

- Max 3 questions; each must genuinely change execution (no "shall I proceed?").
- Each question carries 2–4 concrete options with one-line descriptions.
- `trivial` requires zero questions. When in doubt: `needs_review`.

Parsing: `extractPlanTriage(events)` in `runners/stream-json.ts` — take the **last**
fenced JSON block of the plan text, validate against a zod schema exported from
`@agent-dealer/shared`, strip the block from the stored plan markdown.

**Fallback:** absent or malformed block ⇒ `{ verdict: "needs_review", questions: [] }`
— exactly today's behavior. Contract failure can never be worse than the status quo.

Persistence: `draft_plan` artifact unchanged; new artifact kind **`plan_triage`**
`{ verdict, rationale, questions, sessionId, consumed?: boolean }`.

## 2. Gate logic (dispatcher)

After `draftPlan` persists artifacts, a pure function
`planGateDecision(triage, answers) → "auto_approve" | "await_answers" | "await_review"`
decides:

| Triage result | Next state |
|---|---|
| `trivial`, no questions | Copy draft → `approved_plan` (source `"system"`, rationale attached), `transitionRun(id, "plan_approved")`, `forceDispatch()` |
| Questions present | Stay `plan_pending`; run flagged "needs your answer" in snapshot |
| `needs_review`, no questions | Today's manual review flow, untouched |

No new run statuses; `plan_pending → plan_approved` already exists in the state machine.

Manual **Approve plan** keeps working at any point — answering questions is a faster
path, not a required one. If the human moves a run back `plan_approved → plan_pending`,
mark its `plan_triage` `consumed: true`; a consumed triage never re-auto-approves.

## 3. Answer flow

New route `POST /api/runs/:id/plan/answers`, body validated by shared
`PlanAnswersInput`: `[{ questionId, selectedLabel?, freeText? }]` (exactly one of the
two per answer; all questions must be answered).

- **All structured** → store `plan_answers` artifact; `approved_plan` = draft plan +
  answers; transition to `plan_approved`; `forceDispatch()`. `buildExecutionPrompt`
  gains a `## Human answers to plan questions` section rendered as Q→A pairs.
- **Any free-form** → store `plan_answers`; redraft via `scheduleRedraft`, upgraded to
  `--resume <plan sessionId>` with a short "here are the human's answers — revise the
  plan" prompt. Missing/expired session ⇒ fall back to a fresh `draftPlan` with the
  answers appended as feedback. The new draft re-enters the same triage (it may now be
  trivial and auto-approve, or ask follow-ups).
- **Redraft loop cap:** after 2 question rounds, the next draft always goes to manual
  review even if it still contains questions.

## 4. Dashboard UI

- Plan-review lane gains a third card state: **"needs your answer"** — accent border,
  count in the lane header (same pattern as `planReviewCount`).
- Card expands to one row per question: option buttons with descriptions + an "Other…"
  free-text field. Single **Submit answers** action. If every answer was a button pick,
  the card moves straight to the execution queue.
- Auto-approved runs show an **"auto-approved"** badge in the execution lane; the run
  detail view shows the triage rationale so self-triage stays auditable.
- Snapshot payload gains the flag the UI needs (e.g. `awaitingAnswers` runs or a
  per-run `openQuestions` count) so the lane renders without extra artifact fetches.

## 5. Superpowers for spawned runs

Spawned `claude -p` runs already load user-scope plugins; the superpowers
SessionStart hook (`matcher: startup`) injects skill instructions into every run, but
`Skill` is not in `--allowedTools`, so the capability is unusable today.

Add `Skill` to the `--allowedTools` list for **all spawned phases** (plan, execute,
reflect) in `runners/claude.ts`. Skills are read-only instruction loads, so this is
safe even in the read-only plan/reflect phases; the phase tool allowlist still governs
what the agent can *do* with a skill's guidance. Acceptance: a spawned run's stream
shows a successful `Skill` invocation (no permission denial) when the agent chooses
to use one.

## 6. Error handling

- Malformed/missing contract block → `needs_review`, no questions (fallback above).
- Answers arriving after the run moved on (double-submit, manual approve raced) →
  409, no-op — same late-result guard `draftPlan` already uses.
- Auto-approve races the human: transition only from `plan_pending`; existing
  `after.status` guard wins.
- Free-form redraft without a usable session → fresh draft with answers as feedback.

## 7. Testing

- **Unit:** `extractPlanTriage` (well-formed / missing / malformed / JSON-in-prose
  false positive); `PlanAnswersInput` validation; `planGateDecision` as a pure
  function (verdict × questions × answer shapes → next state).
- **Flow (`scripts/flow-verify.ts`):** three new gates — trivial auto-approve;
  questions → structured answers → execution; free-form answer → redraft → re-triage.
  Agent calls mocked at the runner boundary as today.
- **Smoke:** one real `npm run flow:doc` plan call to confirm the model honors the
  JSON contract end-to-end.

## Out of scope (future)

- Agent SDK interactive planning (mid-plan `AskUserQuestion` interception). The
  `plan_triage`/`plan_answers` artifacts and the answer UI are designed to be reused
  unchanged if we migrate.
