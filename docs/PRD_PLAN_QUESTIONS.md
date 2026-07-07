---
status: implementation-ready
authoring_playbooks: pb_ai_codegen_prd, pb_product_principle
supersedes: docs/superpowers/specs/2026-07-07-plan-questions-and-auto-approve-design.md
related:
  - docs/PRD_V0.md
---

# agent-dealer — Plan Questions & Self-Triage Auto-Approve PRD

**One-liner:** Plan-phase clarifying questions become one-click structured answers, and trivial plans skip human review — the human gate shrinks to exactly where judgment is needed.

**Status:** implementation-ready · **Doc role:** feature PRD (extends `docs/PRD_V0.md`)
**Codegen load path:** `docs/PRD_PLAN_QUESTIONS.md`
**Success criteria (2 weeks after ship):** ≥ 80% of plan-phase questions answered via option buttons (not free-form); zero tasks stuck > 1 day awaiting plan review that self-triage marked trivial.

---

## 1. Product overview

Today the plan phase is a one-shot headless `claude -p` call (`packages/server/src/runners/claude.ts`). The agent cannot ask the human anything — clarifying questions end up as prose buried in the draft plan, easy to miss in the dashboard. Separately, every task waits on human plan review even when the plan is obviously fine; the review gate, not the plan draft (auto, ≤ $0.50), is the real latency. Finally, user-scope plugins (superpowers) already inject skill instructions into every spawned run, but the `Skill` tool is not allowlisted, so runs pay the context cost with no capability.

This feature adds a structured triage contract to the plan output, an answer flow that sends structured answers straight to execution, an auto-approve path for trivial plans, and `Skill` in the spawned-run tool allowlists.

## 2. Target users & roles

| Role | Goal | v1 surface |
|------|------|------------|
| Operator (existing single role) | Unblock queued tasks with minimal review effort; keep audit trail | Dashboard plan-review lane, run detail |

No new roles. Voice and gating model unchanged from `PRD_V0.md`: agents execute, humans set goals and approve outcomes — this PRD narrows *when* approval is required, never *whether* results are reviewed.

## 3. User stories (testable)

**US-1 — Answer plan questions with one click** *(v1)*
As the operator, I want the plan agent's clarifying questions shown as structured options, so that I can answer in one click and send the task to execution.
- [ ] A run whose draft plan contains questions appears highlighted as "needs your answer" with a lane-header count
- [ ] Each question renders 2–4 option buttons with descriptions plus an "Other…" free-text field
- [ ] Submitting all-structured answers transitions the run to `plan_approved` and dispatches execution with **zero additional agent calls**
- [ ] The execution prompt contains a `## Human answers to plan questions` section with Q→A pairs

**US-2 — Trivial plans skip my review** *(v1)*
As the operator, I want obviously-simple tasks to start executing without my plan approval, so that lightweight work flows overnight.
- [ ] A plan with `verdict: "trivial"` and zero questions auto-approves and dispatches without human action
- [ ] The run shows an "auto-approved" badge; run detail shows the triage rationale
- [ ] Moving an auto-approved run back to `plan_pending` marks its triage consumed; it never re-auto-approves
- [ ] Result review before "done" is unchanged

**US-3 — Free-form answers improve the plan** *(v1)*
As the operator, when my answer doesn't fit the options, I want the plan redrafted with my input, so that execution follows an accurate plan.
- [ ] Any free-form answer triggers a redraft that resumes the stored plan session (fallback: fresh draft with answers as feedback)
- [ ] The new draft re-enters triage (may auto-approve, may ask follow-ups)
- [ ] After 2 question rounds, the next draft always goes to manual review

**US-4 — Spawned agents can use my skills** *(v1)*
As the operator, I want agents spawned by agent-dealer to use my installed superpowers skills, so that the context they already pay for becomes capability.
- [ ] `Skill` is in `--allowedTools` for plan, execute, and reflect phases
- [ ] A spawned run's stream shows a successful `Skill` invocation with no permission denial

**US-5 — Mid-plan interactive questions** *(deferred)*
Reason: requires Agent SDK rearchitecture and session suspend/resume across hours of human latency. Path back: the `plan_triage`/`plan_answers` artifacts and the answer UI in this PRD are reused unchanged; only the runner changes (SDK `canUseTool` interception).

## 4. Features & requirements

### F1 — Plan triage contract

| Req ID | Requirement | Acceptance |
|--------|-------------|------------|
| F1.1 | `buildPlanPrompt` instructs the agent to end its reply with a fenced ```json block matching §7.1: verdict, one-sentence rationale, ≤ 3 questions each with 2–4 options. Rules in prompt: questions only when the answer changes execution; `trivial` ⇒ zero questions; when in doubt `needs_review`. | Prompt snapshot test; real-call smoke returns a §7.1-valid block |
| F1.2 | `extractPlanTriage(events)` in `runners/stream-json.ts` parses the **last** fenced JSON block, validates with the shared zod schema, strips the block from stored plan markdown. Absent/invalid ⇒ `{verdict:"needs_review",questions:[]}` + `parseFallback:true`. | Unit tests: well-formed / missing / malformed / JSON-in-prose false positive |
| F1.3 | New artifact kind `plan_triage` (§7.3) persisted alongside `draft_plan`. | Artifact present after every plan draft; `draft_plan` shape unchanged |

### F2 — Auto-approve gate

| Req ID | Requirement | Acceptance |
|--------|-------------|------------|
| F2.1 | Pure function `planGateDecision(triage, answers?) → "auto_approve" \| "await_answers" \| "await_review"` in `@agent-dealer/shared`. | Unit-tested across verdict × questions × answer shapes |
| F2.2 | On `auto_approve`: copy draft to `approved_plan` (source `"system"`, rationale attached), `transitionRun(id,"plan_approved")`, `forceDispatch()`. Transition only from `plan_pending`; existing late-result guard wins races with manual actions. | flow-verify gate: trivial task reaches `running` with no human call |
| F2.3 | `plan_triage.consumed=true` set when a human moves the run `plan_approved → plan_pending`; consumed triage never auto-approves. | flow-verify: un-approved run stays in review |

### F3 — Answer flow

| Req ID | Requirement | Acceptance |
|--------|-------------|------------|
| F3.1 | `POST /api/runs/:id/plan/answers`, body per §7.2. Run not in `plan_pending` or questions already answered ⇒ 409. | Route tests: happy path, 409 double-submit, 404 |
| F3.2 | All-structured answers: persist `plan_answers` (§7.4, outcome `"approved"`), approve plan, dispatch. | flow-verify gate: question → structured answer → `running`, zero extra agent calls |
| F3.3 | `buildExecutionPrompt` renders `## Human answers to plan questions` as Q→A pairs when `plan_answers` exists. | Prompt unit test |
| F3.4 | Any free-form answer: persist `plan_answers` (outcome `"redraft"`), redraft via `--resume <plan sessionId>` with a revise-prompt carrying the answers; missing/expired session ⇒ fresh draft with answers appended as feedback. | flow-verify gate: free-form → new `draft_plan` + new `plan_triage` |
| F3.5 | Question-round cap: after 2 rounds (count of `plan_triage` artifacts with questions, see §12), the next draft goes to manual review even if it contains questions. | Unit test on gate decision with round count |

### F4 — Dashboard

| Req ID | Requirement | Acceptance |
|--------|-------------|------------|
| F4.1 | Plan-review lane distinguishes "needs your answer" (accent border, lane-header count) from plain "ready for review". | UI renders from snapshot alone (no extra artifact fetch) |
| F4.2 | Question card: option buttons + description, "Other…" free-text per question, single **Submit answers** action. | All-structured submit moves card to execution lane |
| F4.3 | "Auto-approved" badge in execution lane; triage rationale in run detail. | Badge visible for F2.2 runs |
| F4.4 | Snapshot payload gains `awaitingAnswerRuns: Run[]` (and per-run `openQuestionCount`). | Snapshot contract test |

### F5 — Superpowers enablement

| Req ID | Requirement | Acceptance |
|--------|-------------|------------|
| F5.1 | Add `Skill` to `--allowedTools` for plan, execute, and reflect argument lists in `runners/claude.ts`. | US-4 acceptance; no other allowlist changes |

## 5. Pricing model

Not applicable — agent-dealer does not host, proxy, or bill. (Section retained to keep scaffold numbering.)

## 6. Design principles

- **Contract failure degrades to status quo.** No parse result can behave worse than today's manual review (load-bearing: F1.2).
- **Answering is a fast path, not a required one.** Manual Approve plan works at every point (load-bearing: F2.3, F3.1's 409 semantics).

## 7. Cross-cutting contracts

### 7.1 Plan triage block (agent output, end of plan reply)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "agent-dealer/plan-triage-block.json",
  "type": "object",
  "required": ["verdict", "rationale"],
  "additionalProperties": false,
  "properties": {
    "verdict": { "enum": ["trivial", "needs_review"] },
    "rationale": { "type": "string", "maxLength": 300 },
    "questions": {
      "type": "array",
      "maxItems": 3,
      "default": [],
      "items": {
        "type": "object",
        "required": ["id", "question", "options"],
        "additionalProperties": false,
        "properties": {
          "id": { "type": "string", "pattern": "^q[0-9]+$" },
          "question": { "type": "string", "maxLength": 300 },
          "options": {
            "type": "array",
            "minItems": 2,
            "maxItems": 4,
            "items": {
              "type": "object",
              "required": ["label"],
              "additionalProperties": false,
              "properties": {
                "label": { "type": "string", "maxLength": 60 },
                "description": { "type": "string", "maxLength": 200 }
              }
            }
          }
        }
      }
    }
  },
  "if": { "properties": { "verdict": { "const": "trivial" } } },
  "then": { "properties": { "questions": { "maxItems": 0 } } }
}
```

### 7.2 `POST /api/runs/:id/plan/answers` request body

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "agent-dealer/plan-answers-input.json",
  "type": "object",
  "required": ["answers"],
  "additionalProperties": false,
  "properties": {
    "answers": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["questionId"],
        "additionalProperties": false,
        "properties": {
          "questionId": { "type": "string" },
          "selectedLabel": { "type": "string", "maxLength": 60 },
          "freeText": { "type": "string", "minLength": 1, "maxLength": 2000 }
        },
        "oneOf": [
          { "required": ["selectedLabel"], "not": { "required": ["freeText"] } },
          { "required": ["freeText"], "not": { "required": ["selectedLabel"] } }
        ]
      }
    }
  }
}
```

Server-side rule (not expressible in schema): every open question id must appear exactly once.

### 7.3 `plan_triage` artifact `contentJson`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "agent-dealer/plan-triage-artifact.json",
  "type": "object",
  "required": ["verdict", "rationale", "questions", "parseFallback"],
  "additionalProperties": false,
  "properties": {
    "verdict": { "enum": ["trivial", "needs_review"] },
    "rationale": { "type": "string" },
    "questions": { "$ref": "agent-dealer/plan-triage-block.json#/properties/questions" },
    "sessionId": { "type": "string" },
    "parseFallback": { "type": "boolean" },
    "consumed": { "type": "boolean", "default": false }
  }
}
```

### 7.4 `plan_answers` artifact `contentJson`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "agent-dealer/plan-answers-artifact.json",
  "type": "object",
  "required": ["answers", "outcome", "answeredAt"],
  "additionalProperties": false,
  "properties": {
    "answers": { "$ref": "agent-dealer/plan-answers-input.json#/properties/answers" },
    "outcome": { "enum": ["approved", "redraft"] },
    "answeredAt": { "type": "string", "format": "date-time" }
  }
}
```

## 8. Technical constraints & preferences

- TypeScript monorepo; zod schemas mirroring §7 live in `packages/shared/src` and are the single runtime source of truth (JSON Schemas above are the contract of record; zod must stay equivalent).
- No new run statuses; reuse `plan_pending → plan_approved` transitions and the dispatcher's existing late-result guards.
- Routes in `packages/server/src/routes/index.ts` (fastify); artifacts via `addArtifact` in SQLite; UI in `apps/web`.
- **Codegen load path:** `docs/PRD_PLAN_QUESTIONS.md`. Repo-specific UI chrome stays in `.cursor/rules/agent-dealer.mdc`.

## 9. Non-functional requirements

| NFR | Target | Measurement |
|-----|--------|-------------|
| Triage parse success | ≥ 95% of plan drafts yield a §7.1-valid block | `parseFallback` flag over the first 20 real plan runs after ship |
| Auto-approve precision | ≤ 1 in 10 auto-approved runs is retried with human feedback | Retry-with-feedback rate over the first 10 auto-approved runs |
| Structured-answer latency | 0 additional agent calls between answer submit and execution dispatch | Asserted in flow-verify gate on every CI run |
| Needs-answer visibility | New questions visible in dashboard ≤ 5 s after plan draft persists | Snapshot push timing in flow-verify (existing notify path) |

## 10. Out of scope

- Agent SDK interactive planning (US-5 — deferred, path back defined there)
- Any change to execute-phase budgets, tool allowlists (beyond `Skill`), or result review
- Human "quick task" intake toggle and heuristic/classifier triage (self-triage chosen; revisit only if NFR auto-approve precision fails)
- Suppressing user plugins in spawned runs (decision reversed 2026-07-07: enable, don't suppress)
- Linear write-back of question/answer events

## 11. Milestones

| Week | Exit criteria |
|------|---------------|
| 1 | F1 + F2 + F3 landed; unit tests green; three new flow-verify gates pass (trivial auto-approve; structured answers → running; free-form → redraft) |
| 2 | F4 + F5 landed; one real `flow:doc` smoke shows contract honored and a successful `Skill` invocation; NFR instrumentation (parseFallback, auto-approve badge) queryable |

## 12. Open decisions

| Question | Default if undecided | Owner |
|----------|----------------------|-------|
| How are question rounds counted for the F3.5 cap? | Count of `plan_triage` artifacts on the run whose `questions` is non-empty | Longhao |
| Does auto-approve apply to Linear-sourced tasks identically to manual tasks? | Yes — source does not affect gating | Longhao |
| Snapshot field shape for the UI | `awaitingAnswerRuns: Run[]` + per-run `openQuestionCount` (F4.4) | Longhao |

## 13. How to use this PRD

- **Engineers / AI codegen:** load this file; implement pillars in order F1 → F2 → F3 → F4 → F5. Every Req ID's acceptance column is the definition of done; §7 schemas are copy-paste contracts — do not restate shapes inline in code comments.
- **Verification:** extend `scripts/flow-verify.ts` with the three gates named in §11 week 1; mock agent calls at the runner boundary as existing gates do.
- **Review:** the human approval model of `PRD_V0.md` still governs; this PRD only adds the auto-approve and answer fast paths.

---

## Appendix — source notes

| Source | Captured as |
|--------|-------------|
| Brainstorming session 2026-07-07 (approach + guardrail decisions with Longhao) | §3 stories, §6 principles, §10 negative space |
| `docs/superpowers/specs/2026-07-07-plan-questions-and-auto-approve-design.md` | Superseded by this PRD (frontmatter chain) |
| `packages/server/src/runners/claude.ts`, `runners/prompts.ts`, `runners/persist.ts`, `queue/dispatcher.ts` | §1 current behavior, §8 constraints |
| `~/.claude/settings.json` + superpowers plugin `hooks.json` inspection | US-4 rationale |
