---
status: approved-design
related:
  - docs/PRD_PLAN_QUESTIONS.md
  - docs/PRD_V0.md
---

# Result Q&A thread & explicit plan delegation — design

**One-liner:** Reviewers can ask the agent questions about a result without paying for a re-execution, and approving a plan past its open questions becomes an explicit, auditable delegation instead of silent information loss.

## Problem

1. **Result review is approve-or-retry only.** The result panel offers "Mark done & next" or "Retry with new instructions" (full re-execution). Reviewers often need a middle path — "why did you choose X?", "did you check Y?" — to *decide* whether to approve, to extract knowledge from the result, or as the first step toward a fix request.
2. **"Approve as-is" with open plan questions drops the questions.** Triage strips the questions block from the stored plan markdown (`extractPlanTriage`), so approving without answering sends the executor a plan whose own author flagged it as underspecified — with no trace that questions ever existed.

## Decisions (made with Longhao, 2026-07-07)

- Q&A must serve all three outcomes: judging approve/retry, escalating into a fix request with context, and knowledge extraction that outlives the run.
- Approach A chosen: **session-resume Q&A thread** (stateless fresh-call is its fallback, not an alternative; live streaming chat deferred).
- Asking is allowed in **review and done**.
- "Approve as-is" is **kept but made explicit**: relabeled delegation, questions passed to the executor marked unanswered.

## 1. Data & contracts (`packages/shared`)

### `result_qa` artifact (new kind), one per exchange

```json
{
  "exchangeId": "string (unique per run)",
  "question": "string, 1..2000",
  "answer": "string | absent until answered",
  "status": "pending | answered | failed",
  "sessionResumed": "boolean",
  "askedAt": "ISO date-time",
  "answeredAt": "ISO date-time | absent"
}
```

- Artifacts are append-only: the pending exchange is persisted first; completion appends a new `result_qa` artifact with the same `exchangeId`. **Latest artifact per `exchangeId` wins**; the thread is exchanges ordered by `askedAt`.
- Zod schema in `packages/shared/src` is the runtime source of truth (same convention as `plan_triage`/`plan_answers`).

### `plan_answers` outcome extension

`outcome` enum gains `"delegated"`. A delegated record has `answers: []`. Existing `"approved"`/`"redraft"` semantics unchanged.

## 2. Server — QA endpoint and runner phase

### `POST /api/runs/:id/qa` — body `{ "question": string }`

| Case | Response |
|------|----------|
| Run in `review` or `done`, no pending exchange | Persist pending `result_qa`, start answer job async, return the exchange |
| An exchange on this run is still `pending` | 409 (serializes access to the resumed session) |
| Run in any other status | 409 |
| Unknown run | 404 |

### QA runner phase

New phase `"qa"` reusing the existing runner infrastructure (`runners/claude.ts`, `persist.ts`):

- **Resume:** `--resume <sessionId>` from the latest `agent_session` artifact with `phase: "execute"`. The agent answers from the working memory of the run that produced the result.
- **Prompt:** the reviewer's question plus instructions to answer concisely in markdown and make **no modifications**.
- **Tool allowlist:** read-only — `Read`, `Grep`, `Glob`, `Skill`. No Write/Edit/Bash.
- **Model/budget:** the run's execute model; fixed budget cap of $0.25 per exchange (not user-configurable in v1 — half the plan-draft cap, since answering is cheaper than planning).
- **Fallback:** missing session ID or failed resume → fresh call with approved plan + execution result + deliverable as context; record `sessionResumed: false`. (Same degradation pattern as PRD_PLAN_QUESTIONS F3.4.)
- **Failure:** runner error → append the exchange with `status: "failed"`; the UI offers re-ask. A failed QA never affects run status.
- Usage is persisted per phase as today and appears in the run's usage summary.

## 3. Retry carries the discussion

When answered `result_qa` exchanges exist on the run, the retry execution prompt gains:

```
## Review Q&A
Q: <question>
A: <answer>
...
```

rendered by `buildExecutionPrompt`/retry prompt in `runners/prompts.ts`. No UI action needed — the discussion travels automatically.

## 4. Web UI

New component `apps/web/src/components/drawer/ResultQaThread.tsx`, rendered in:

- **`ResultReviewPanel`** — above the "Your Decision" section.
- **`DoneReviewPanel`** — below the deliverable.

Behavior:

- Exchange cards: question line + markdown-rendered answer (`MarkdownBody`); pending exchanges show a working indicator and reuse the existing 3 s artifact-polling pattern.
- Input: textarea + "Ask" button; disabled while an exchange is pending.
- Helper text near the retry field when a thread exists: "This discussion is included automatically if you retry."
- A `sessionResumed: false` answer shows a subtle "answered from artifacts" note (the agent no longer had its working session).

## 5. Plan delegation (server-enforced)

- **Route-level rule:** approving a plan (`updatePlan` approve path) while the latest `plan_triage` has open unanswered questions persists `plan_answers` `{ answers: [], outcome: "delegated", answeredAt }` and marks the triage consumed. Enforced in the route so *every* approve path records it, not just the button.
- **`buildExecutionPrompt`:** when the latest `plan_answers.outcome === "delegated"`, render:

  ```
  ## Unanswered plan questions
  The reviewer chose to proceed without answering these. Use your best judgment.
  - <question 1> (options: ...)
  ...
  ```

- **`PlanReviewPanel`:** when open questions exist, the approve button relabels to **"Proceed — agent decides →"** and the divider reads "or skip the questions". No behavior change when there are no open questions.
- Interaction with the F3.5 round cap: none — delegation ends the question loop by dispatching execution.

## Testing

- **Unit:** zod schemas (`result_qa`, extended `plan_answers`); prompt sections (`## Review Q&A`, `## Unanswered plan questions`, QA prompt); route tests (happy path, 409 pending, 409 wrong status, 404).
- **flow-verify gates** (runner mocked at the boundary, as existing gates):
  1. QA: question → pending artifact → answered artifact; retry prompt contains the Q&A section.
  2. Delegation: plan with questions + approve-as-is → `plan_answers` outcome `delegated` + execution prompt contains the delegation section.

## Out of scope

- Live streaming chat with the run's agent (Approach C; `result_qa` artifacts are reused unchanged if built later).
- QA on `failed` runs (natural cheap follow-up).
- Per-agent QA model/budget configuration.
- Linear write-back of Q&A events.
