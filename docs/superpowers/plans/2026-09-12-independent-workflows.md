# Independent Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Task coordinator implementation with independent workflow templates (Clarify, Dev-review, Message); keep the dual legacy-run runtime **retired** (already landed in [NOT-71](https://linear.app/not-so-fat/issue/NOT-71) / PR #59) so the product stays easy to extend — while keeping a **usable-ASAP** Dev-review path that does **not** wait on registry or new templates.

**Architecture:** Shared issue / worker-session / human-action machinery inside the Task coordinator; each workflow is a registered template (stages, transitions, prompts, effects). No in-product chaining between templates. Operator composes work outside agent-dealer. Clarify may create new agent-dealer issues at status `ready` (no active workflow instance) as deliverables.

**Tech Stack:** TypeScript monorepo (`packages/shared`, `packages/server`, `apps/web`, `packages/cli`), Fastify, SQLite, `node:test` via `tsx --test`.

**Source spec:** `docs/superpowers/specs/2026-09-12-independent-workflows-architecture-design.md`

## Global Constraints

- Do **not** build Clarify→Dev→Message (or any) cross-workflow orchestration in the coordinator.
- Clarify-created issues: create only; **never** auto-start; no pipeline linkage between the Clarify issue and the issues it creates.
- Keep `dev_reviewer_v1` behavior intact while extracting the registry (Task 2 is a pure refactor + tests).
- Dual runtime is **already retired** (NOT-71): do not reintroduce `startQueue()` / plan→execute writers beside the Task coordinator. Remaining `queue/` files are leftovers or issue-queue helpers — delete dead code over time, do not treat NOT-71 as unstarted work.
- **Do not treat registry / new-template work as a gate on using today’s Dev-review product.** Usable-ASAP tickets can ship in parallel with (or ahead of) architecture Tasks 2–5.
- Branch each ticket from latest `main` after prior ticket merges (squash-merge repo).
- Tests: `npm run build -w @agent-dealer/shared && npx tsx --test <path>`; full unit: `npm run test:unit`. Typecheck + package build before handoff.
- Do not commit unless the user asks.

## Ticket map — two tracks

### Usable-ASAP track (existing Dev-review)

These make the shipping Dev-review product operable by a coding agent. They are **not** blocked on the workflow registry or Clarify/Message.

| Order | Linear | One-line deliverable |
|-------|--------|----------------------|
| A | [NOT-77](https://linear.app/not-so-fat/issue/NOT-77) | **Critical blocker** — restore Agent Deck-backed profile setup (deck picker / authenticated metadata discovery; empty picker / `GRANT_REQUIRED` is unusable) |
| B | [NOT-76](https://linear.app/not-so-fat/issue/NOT-76) | **Complete agent-operated CLI surface**, including discovery (`agent list`, `issue list`, `issue start`, `action resolve`) |
| C | [NOT-79](https://linear.app/not-so-fat/issue/NOT-79) | **Concrete end-to-end release gate** — prove the agent-operated Dev-review happy path |

Recommended order: **NOT-77 → NOT-76 → NOT-79** (NOT-79 is blocked by both). See also `docs/AGENT_OPERATED_DEV_REVIEW.md`.

### Architecture landing track (templates / envelope)

| Task | Linear | One-line deliverable | Status |
|------|--------|----------------------|--------|
| 0 | [NOT-68](https://linear.app/not-so-fat/issue/NOT-68) | Parent — track architecture + children | open |
| 1 | [NOT-69](https://linear.app/not-so-fat/issue/NOT-69) | Docs landed (this plan + design + usable-ASAP map) | in progress |
| 2 | [NOT-70](https://linear.app/not-so-fat/issue/NOT-70) | Workflow registry; `dev_reviewer_v1` behind it | open |
| 3 | [NOT-71](https://linear.app/not-so-fat/issue/NOT-71) | Retire dual runtime (legacy queue / planner UI off default path) | **done** (PR #59 / `d105672`) — do not re-run Task 3 steps |
| 3b | [NOT-78](https://linear.app/not-so-fat/issue/NOT-78) | **Template-neutral** Issue / WorkflowInstance envelope — **blocks** Clarify/Message so those templates do not extend a Dev-review-shaped universal Issue model | open |
| 4 | [NOT-73](https://linear.app/not-so-fat/issue/NOT-73) | Clarify template + optional `ready` (unstarted) issue creation | open |
| 5 | [NOT-72](https://linear.app/not-so-fat/issue/NOT-72) | Message template (draft → approve → send) | open |

Recommended remaining architecture order: **NOT-69 → NOT-70 → NOT-78 → NOT-73 → NOT-72**. [NOT-71](https://linear.app/not-so-fat/issue/NOT-71) is **already merged** — skip its inventory/remove-startup steps. Clarify and Message both depend on the registry **and** the template-neutral envelope ([NOT-78](https://linear.app/not-so-fat/issue/NOT-78) blocked by NOT-70; blocks NOT-73/NOT-72). **None of Tasks 2–5 are prerequisites for the usable-ASAP track.**

### Related follow-ups (not ASAP blockers)

| Linear | Category | Note |
|--------|----------|------|
| [NOT-74](https://linear.app/not-so-fat/issue/NOT-74) | Quality / trust hardening | Require Lens self-review before developer→reviewer handoff; not required to prove basic coordinator operability |
| [NOT-75](https://linear.app/not-so-fat/issue/NOT-75) | Deferred UI refinement | Inline resolve for every human-action type on issue detail; CLI + attention surfaces cover the ASAP path |

## File Structure (foundation)

**Create (Task 2):**
- `packages/server/src/coordinator/workflows/types.ts` — `WorkflowTemplate` interface
- `packages/server/src/coordinator/workflows/registry.ts` — register / get by version string
- `packages/server/src/coordinator/workflows/dev-reviewer-v1.ts` — move/adapt current legality + effect routing for this template
- `packages/server/src/coordinator/workflows/registry.test.ts`

**Modify (Task 2):**
- `packages/server/src/coordinator/commands.ts` — resolve template via registry (`WORKFLOW_VERSION` stays `dev_reviewer_v1` default)
- `packages/server/src/coordinator/routing.ts` / `effect-registry.ts` — dispatch by template id if today hardcoded
- `packages/shared/src/issues.ts` (or adjacent) — optional `workflowVersion` on create/start if not already present

**Modify (Task 3 — DONE in NOT-71 / PR #59):**
- ~~`packages/server/src/index.ts` — stop `startQueue()` / orphan recovery~~ — coordinator-only startup already
- ~~Run-centric UI / mutating run APIs~~ — Issues + Agents shell; plan/execute product removed
- Docs already note historical PRD_V0 / NOT-71 retirement (README); leftover `queue/` dead code may still be deleted opportunistically

**Modify (Task 3b / NOT-78):**
- Shared issue / workflow-instance model — separate generic lifecycle from template stage; persist template version + current stage on the instance
- Re-home Dev-review-only repo/branch/PR/SHA/round/role fields so they are not required universal Issue columns
- Preserve `dev_reviewer_v1` behavior via migration / compatibility wrap

**Create (Task 4):**
- `packages/server/src/coordinator/workflows/clarify-v1.ts`
- Clarify prompts, human-action types as needed, issue-creation effect
- Tests: start clarify → human approve → created issues exist, status ready, not started

**Create (Task 5):**
- `packages/server/src/coordinator/workflows/message-v1.ts`
- Reuse ideas from `docs/PRD_SEND_GATE.md` / `queue/send-gate` / approve-deliver — on **issue** model, not runs
- Tests: draft artifact → approve → send receipt; nothing sent before approve

---

### Task 1: Land architecture docs

**Files:**
- Create: `docs/superpowers/specs/2026-09-12-independent-workflows-architecture-design.md`
- Create: `docs/superpowers/plans/2026-09-12-independent-workflows.md`
- Create/update: `CONTEXT.md` — three-module vocabulary
- Modify: `README.md` — opening aligned to the same architecture

**Interfaces:**
- Produces: approved written contract for architecture Tasks 2–5 **and** the usable-ASAP track map

- [x] **Step 1:** Ensure design + plan are in repo and linked from Linear parent description.
- [x] **Step 2:** Ticket map includes usable-ASAP (NOT-77/76/79), NOT-78 template-neutral boundary, and NOT-74/75 categorization.
- [x] **Step 3:** Commit only if the user asks (docs-only PR is fine).

**Acceptance:** Design principles (three modules, independent templates, no in-product chaining, Clarify-created issues at `ready`/no active instance, dual-runtime retirement) are written; plan does **not** imply registry/template work must land before Dev-review can be used; NOT-77/76/79 and NOT-78 roles are explicit.

---

### Task 2: Workflow registry seam (no behavior change)

**Files:**
- Create: `packages/server/src/coordinator/workflows/types.ts`
- Create: `packages/server/src/coordinator/workflows/registry.ts`
- Create: `packages/server/src/coordinator/workflows/dev-reviewer-v1.ts`
- Create: `packages/server/src/coordinator/workflows/registry.test.ts`
- Modify: `packages/server/src/coordinator/commands.ts`
- Modify: related routing / start paths that hardcode `"dev_reviewer_v1"`

**Interfaces:**
- Produces: roughly

```ts
type WorkflowTemplate = {
  version: string; // e.g. "dev_reviewer_v1"
  // pure transition helpers / role list / effect kinds this template uses
};
function getWorkflow(version: string): WorkflowTemplate;
function listWorkflows(): WorkflowTemplate[];
```

- Consumes: existing `startWorkflow` / command transaction patterns in `commands.ts`

- [ ] **Step 1:** Write failing registry tests — unknown version throws; `dev_reviewer_v1` resolves.
- [ ] **Step 2:** Implement `types` + `registry` + register `dev_reviewer_v1`.
- [ ] **Step 3:** Point `WORKFLOW_VERSION` / start path through `getWorkflow` without changing transitions.
- [ ] **Step 4:** Run existing coordinator tests (`commands.test.ts`, routing, repair-cycle integration) — expect green with no product diffs.
- [ ] **Step 5:** `npm run typecheck` + `npm run test:unit` for touched packages.

**Acceptance:** Adding a second template is a new file + `registerWorkflow` call; `dev_reviewer_v1` still passes its prior acceptance scenarios.

**Non-goals:** Clarify/Message behavior; deleting legacy queue; template-neutral envelope (NOT-78).

---

### Task 3: Retire dual runtime (legacy queue off default path) — **DONE**

> **Landed in [NOT-71](https://linear.app/not-so-fat/issue/NOT-71) / PR #59 (`d105672`).** Do **not** inventory `startQueue` / `recoverOrphanedRuns` or re-remove startup wiring — `packages/server/src/index.ts` already starts only `recoverCoordinator` + `startCoordinatorLoop`. README already calls PRD_V0 historical (“plan/execute product removed in NOT-71”). Remaining work is opportunistic dead-code cleanup under `queue/`, not re-executing this task.

**Files (historical — already applied):**
- `packages/server/src/index.ts` — coordinator-only loop
- Legacy plan/execute UI, Inbox/Operations routes, and mutating run APIs removed or reduced to leftovers
- Issue-centric shell (Issues + Agents)

**Interfaces:**
- Produces: server process that runs **only** the Task coordinator loop by default — **satisfied**

- [x] **Step 1:** Inventory live writers: `startQueue`, `recoverOrphanedRuns`, POST run routes, UI entry points.
- [x] **Step 2:** Add tests or startup assertion that coordinator recovers/starts; legacy queue does not tick by default.
- [x] **Step 3:** Remove or hard-gate legacy startup and mutating run APIs.
- [x] **Step 4:** Point primary UI at issues; leave read-only legacy audit only if still needed for `legacy_v0_*` data.
- [x] **Step 5:** Smoke: issue-centric product path without starting a legacy run.

**Acceptance:** Fresh install / default `agent-dealer` server never enqueues legacy plan→execute runs. Issue Dev-review still works. **Met in NOT-71.**

**Non-goals (then and now):** Implementing Clarify/Message; deleting every leftover legacy file in one PR (dead code can follow).

---

### Task 3b: Template-neutral Issue / WorkflowInstance envelope (NOT-78)

**Files:**
- Shared issue / workflow-instance schema and types
- Coordinator create/start paths and Dev-review-specific field homes
- Migration / compatibility for existing `dev_reviewer_v1` rows

**Interfaces:**
- Produces: generic issue lifecycle separate from template stage; `workflow_instances` exposes template version + current stage/state; templates validate their own inputs/roles

- [ ] **Step 1:** Document current Dev-review-shaped universal fields (statuses, required developer/reviewer, PR/SHA on `issues`).
- [ ] **Step 2:** Failing test: a minimal non-code template can create/start without fake repo/developer/reviewer/PR/round values.
- [ ] **Step 3:** Persist template version + stage on the workflow instance; re-home Dev-review-only config.
- [ ] **Step 4:** Keep Dev-review lifecycle/recovery tests green.
- [ ] **Step 5:** Typecheck + targeted suite.

**Acceptance:** Adding Clarify or Message does not require extending a global Dev-review-shaped `IssueStatus` enum. No generic graph editor; no cross-workflow chaining.

**Depends on:** NOT-70. **Blocks:** NOT-73, NOT-72.

---

### Task 4: Clarify workflow template

**Files:**
- Create: `packages/server/src/coordinator/workflows/clarify-v1.ts` (+ prompts/tests)
- Modify: registry, create/start API to accept `workflowVersion: "clarify_v1"`
- Modify: web issue create/start to pick template
- Modify: human-action resolution for clarify approval

**Interfaces:**
- Produces: `clarify_v1` registered template
- Deliverable effect: optional `createIssue(...)` for each proposed ticket → status `ready`, **no** `startWorkflow`

- [ ] **Step 1:** Spec the clarify stages in-code (e.g. clarifying → awaiting_human → done) as a pure transition table.
- [ ] **Step 2:** Failing integration test: start clarify issue → agent/session produces proposal → human approves → N new issues exist, none have active workflow instance.
- [ ] **Step 3:** Implement prompts + effect + human gate.
- [ ] **Step 4:** UI: choose Clarify at create/start; show resulting ticket list on the Clarify issue.
- [ ] **Step 5:** Typecheck + targeted tests + one manual/API smoke.

**Acceptance:** Operator can run Clarify alone end-to-end; created agent-dealer issues stay at status `ready` with no active workflow instance until manually started on any template.

**Non-goals:** Auto-starting the issues Clarify creates; spawning Dev-review from Clarify.

**Depends on:** NOT-70, NOT-78.

---

### Task 5: Message workflow template

**Files:**
- Create: `packages/server/src/coordinator/workflows/message-v1.ts` (+ tests)
- Lift patterns from `docs/PRD_SEND_GATE.md` and any still-useful `queue/approve-deliver.ts` / send-gate logic onto issue artifacts
- Modify: registry, UI review card for draft → Approve & send

**Interfaces:**
- Produces: draft artifact on the issue; server-side send on approve; `send_receipt` artifact

- [ ] **Step 1:** Failing test: message issue completes worker with draft; approve triggers send; before approve, no send.
- [ ] **Step 2:** Implement template + deliver effect (deck `call_service_tool` from **server**, not worker).
- [ ] **Step 3:** Wire human action / review UI.
- [ ] **Step 4:** Permission: worker cannot send (align with send-gate lockdown intent).
- [ ] **Step 5:** Typecheck + tests + one Slack (or mock) smoke if credentials allow.

**Acceptance:** Message workflow never uses legacy `startQueue`. Approved bytes are the bytes sent.

**Non-goals:** Merge gates, ticket-status gates, mid-run pause/resume.

**Depends on:** NOT-70, NOT-78 (dual-runtime retirement already done in NOT-71).

---

## Out of scope (later)

- Research/content template
- Lens on agent profiles
- Session scheduling (“run when 5h window free”) as first-class policy
- Deleting every legacy file under `packages/server/src/queue/` in the foundation PRs
