# agent-dealer vocabulary

## Three modules

agent-dealer is only these three pieces. Everything else is an internal of the Task coordinator or a workflow template — not a fourth product module.

| Module | Owns | Does not own |
|--------|------|--------------|
| **Agent profile** | Reusable execution config: coding runtime (Claude / Codex / Cursor), model, workspace, Agent Deck binding, playbooks, permissions, limits | Durable conversational memory across issues (learning goes to Agent Deck / explicit stores) |
| **Task coordinator** | Issues, workflow instances, worker sessions, human actions, evidence; starts **one** registered workflow template per issue; HTTP/CLI API | Cross-issue pipelines (Clarify → Dev → Message chaining stays outside the product) |
| **GUI / API** | Create / start / monitor / resolve issues; same API for humans and agents | A second orchestration path beside the Task coordinator |

**Independent templates:** an issue runs exactly one workflow template to completion (e.g. Dev-review today; Clarify and Message planned). The operator composes work outside agent-dealer. Clarify may create new issues at status `ready` with no active workflow instance — it does not auto-start them.

**Dual runtime:** the legacy plan→execute queue is not a peer of the Task coordinator; retire it from the default path rather than maintain two products in one process.

**Usable-ASAP:** registry and new templates are not a gate on using Dev-review today. Critical path for an agent-operated Dev-review product: [NOT-77](https://linear.app/not-so-fat/issue/NOT-77) (Agent Deck-backed profile setup) → [NOT-76](https://linear.app/not-so-fat/issue/NOT-76) (complete CLI including discovery) → [NOT-79](https://linear.app/not-so-fat/issue/NOT-79) (end-to-end release gate). Template-neutral envelope ([NOT-78](https://linear.app/not-so-fat/issue/NOT-78)) blocks Clarify/Message so they do not extend a Dev-review-shaped universal Issue model.

**Design / plan:** `docs/superpowers/specs/2026-09-12-independent-workflows-architecture-design.md` · `docs/superpowers/plans/2026-09-12-independent-workflows.md` · Linear [NOT-68](https://linear.app/not-so-fat/issue/NOT-68)

## Issue

The durable internal unit of coordination. An issue holds the requested outcome, conversation, workflow history, human decisions, evidence, artifacts, and final result. It may originate in Linear, GitHub, or a manual PRD, but its agent-dealer history remains available independently of that source.

## Workflow template

A reusable, versioned definition of the allowed stages, transitions, roles, gates, limits, and escalation rules for an issue. Coding agents may act within the template; they do not rewrite its topology.

## Workflow instance

One issue progressing through a specific version of a workflow template. It records the current stage and the complete transition history.

## Agent profile

A reusable execution configuration: role instructions, coding runtime, model settings, workspace defaults, accessible skills and playbooks, Agent Deck binding, memory access, permissions, and limits. It is not a growing persona or owner of durable conversational memory.

## Worker session

A temporary coding-agent process started from an agent profile to perform one workflow responsibility. Its transcript and outputs belong to the issue; the worker itself does not accumulate identity or memory across issues.

## Human action

A typed, unresolved decision or input requested from a person, such as resolving ambiguous scope, handling escalation, or approving the final result. Human actions appear both in the issue history and in a global attention queue.

## Issue timeline

The chronological, human-readable projection of an issue's conversation and structured workflow events. It combines normal messages with typed cards for transitions, findings, evidence, artifacts, and human actions.

## Workflow event

An append-only structured record of something that happened to an issue or workflow instance. Events are the data-collection backbone used to reconstruct state, explain agent communication, audit decisions, and test future workflow improvements.
