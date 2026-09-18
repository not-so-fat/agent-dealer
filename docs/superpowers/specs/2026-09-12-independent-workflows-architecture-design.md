# Design: Independent workflows architecture

**Status:** approved for planning  
**Date:** 2026-09-12  
**Related:** ADR 0001–0003, `docs/PRD_ISSUE_COORDINATION.md`, `docs/PRD_SEND_GATE.md` · Linear [NOT-68](https://linear.app/not-so-fat/issue/NOT-68)

## Problem

agent-dealer grew a solid issue-centric Task coordinator that already runs the `dev_reviewer_v1` workflow template, while still starting the legacy plan→execute→review queue in the same process. That dual runtime, plus leftover plan/execute agent fields, makes the product harder to change than the mental model requires.

We need **flexibility for more workflow shapes** without a second product path and without building cross-workflow orchestration inside agent-dealer.

## Principles

1. **Three modules only:** Agent profile · Task coordinator · GUI/API.
2. **One Task coordinator implementation:** issues, worker sessions, human actions, evidence — shared by every workflow template (not a second peer module).
3. **Workflows are independent templates:** an issue runs exactly one template to completion. No Clarify→Dev→Message graph in-product.
4. **Composition stays outside:** the operator (or Linear, or another tool) decides what runs next.
5. **Delete dual runtime:** legacy queue/runs are not a long-term peer of the Task coordinator.
6. **Usable before more templates:** a complete, agent-operated Dev-review path is a release gate; architecture alone is not useful.

## Modules

### Agent profile

Reusable configuration: coding runtime (Claude / Codex / Cursor), model, workspace, Agent Deck (and later lens if needed). Profiles are configuration, not durable personas (ADR 0002). Glossary term in `CONTEXT.md`.

### Task coordinator

API-first: create/start/monitor/resolve an issue on a chosen workflow template. Same surface for GUI, CLI, and coding agents. Scheduling (e.g. wait for a long session window) may come later as Task coordinator policy — not a fourth module.

### GUI / API

Thin clients over the Task coordinator. Reading surfaces stay issue-centric (review drawer pattern).

## Workflow templates (independent)

| Template | Purpose | Typical human gate | Deliverable |
|----------|---------|--------------------|-------------|
| **Clarify** | Size/split, grill for missing context, high-level approach | Approve scope / plan | Tickets: external and/or **new agent-dealer issues** (created at status `ready`, **not** auto-started, **no** active workflow instance, **not** linked as a pipeline) |
| **Dev-review** | Implement + reviewer loop (`dev_reviewer_v1` today) | Final review / escalations | PR + verified SHA trail |
| **Message** | Draft outbound communication | Approve & send (server sends) | Message + send receipt |

Research/content briefs are **out of MVP** (fold later if needed). Email is the same pattern as Message (channel differs).

### Clarify → new agent-dealer issues

Allowed: Clarify may create additional agent-dealer issues as deliverables.  
Forbidden: auto-starting those issues, or linking them as steps in a product-owned workflow graph. The operator starts each later with whichever template they choose.

## Non-goals

- Generic workflow graph editor / agent-rewritable topology
- In-product chaining of templates
- Keeping legacy queue + Task coordinator as two first-class runtimes
- Research template in this cut
- Lens on Agent profiles (defer)

## Target shape

```text
Agent profiles
      │
      ▼
Task coordinator (one implementation)
  ├── clarify_v1
  ├── dev_reviewer_v1   (exists)
  └── message_v1
      │
      ▼
GUI / CLI / HTTP API
```

Each workflow is a registered template: stages, transitions, role prompts, effects. The Task coordinator validates transitions, leases work, records events.

## Two tracks (do not serialize usability behind architecture)

### Usable-ASAP track (existing Dev-review product)

Architecture and new templates must **not** block operating today’s Dev-review path. Prove agent-operated usability first:

1. [NOT-77](https://linear.app/not-so-fat/issue/NOT-77) — **critical blocker** for Agent Deck-backed profile setup (deck picker / authenticated metadata discovery).
2. [NOT-76](https://linear.app/not-so-fat/issue/NOT-76) — complete agent-operated CLI surface, including discovery (`agent`/`issue` list, start, action resolve).
3. [NOT-79](https://linear.app/not-so-fat/issue/NOT-79) — **concrete end-to-end release gate**: agent-operated Dev-review happy path.

### Architecture landing path (templates / envelope)

1. Architecture docs + ticket map (this design + plan) — [NOT-69](https://linear.app/not-so-fat/issue/NOT-69)
2. Workflow registry seam — put `dev_reviewer_v1` behind a template interface with **no behavior change** — [NOT-70](https://linear.app/not-so-fat/issue/NOT-70)
3. Retire dual runtime — stop legacy queue from default server path; remove/gate run-centric UI writers — [NOT-71](https://linear.app/not-so-fat/issue/NOT-71)
4. Template-neutral Issue / WorkflowInstance envelope — [NOT-78](https://linear.app/not-so-fat/issue/NOT-78) (**blocks** Clarify/Message so they do not extend a Dev-review-shaped universal Issue model)
5. Clarify template (including optional creation of unlinked agent-dealer issues at `ready`) — [NOT-73](https://linear.app/not-so-fat/issue/NOT-73)
6. Message template (draft → approve → send on the issue model) — [NOT-72](https://linear.app/not-so-fat/issue/NOT-72)

Dev-review stays the production coding path while later tickets re-home it behind the registry and add peers. Registry/template work is **not** a prerequisite for using Dev-review today.

### Related, not basic-usability blockers

- [NOT-74](https://linear.app/not-so-fat/issue/NOT-74) — **quality / trust hardening** (Lens self-review before developer→reviewer handoff); important before broad rollout, not required to prove basic coordinator operability.
- [NOT-75](https://linear.app/not-so-fat/issue/NOT-75) — **deferred UI refinement** (inline resolve for every human-action type on issue detail); CLI and attention surfaces cover the ASAP path.

## Success criteria

- An operator can explain the product in the three-module language (Agent profile · Task coordinator · GUI/API) without mentioning “legacy runs”
- Starting an issue requires choosing (or defaulting) a **workflow template**, not a second product mode
- Clarify can mint new agent-dealer issues that appear in the list at status `ready` with no active workflow instance until explicitly started
- Message can complete draft → approve → send without using the legacy run queue
- `packages/server/src/index.ts` does not start both `startQueue()` and the Task coordinator as peer products
- Docs and tickets make the usable-ASAP track explicit so registry/template work is not mistaken for the only priority
