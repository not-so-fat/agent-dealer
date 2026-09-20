---
status: proposal
owner: Yusuke Muraoka
linear: NOT-57
related:
  - NOT-48
last_aligned: 2026-09-10
---

# agent-dealer issue coordination — Product Requirements Document

**One-liner:** agent-dealer coordinates temporary coding agents around one durable issue, advances a maintainer-defined workflow autonomously, and asks for human attention only when a real decision or final review is required.

**Document role:** concrete product direction for the issue-centric rework. This proposal does not replace `docs/PRD_V0.md` until it is accepted and implementation sequencing is agreed.

## 1. Product decision

agent-dealer will focus on **coordination around an issue**, not general-purpose automation.

An issue owns the goal, workflow state, human conversation, agent work, pull request, reviews, findings, evidence, cost, and final decision. Individual agent runs are temporary implementation details within that history.

The first supported workflow is one developer–reviewer loop for software work. It is intentionally hardcoded and narrow so its behavior can be observed, measured, and improved before more workflows are introduced.

## 2. Product principles

### 2.1 Issue before run

The durable object is an internal issue. Linear and GitHub are authoritative external artifacts and synchronization targets, but neither substitutes for agent-dealer's coordination record.

One issue may have many worker sessions and review rounds, but at most one active workflow instance.

### 2.2 Autonomous by default

Prepared work should continue without waiting for routine human approval. A developer can hand work to a reviewer, a reviewer can return findings to a developer, and checks can trigger the next allowed step automatically.

Humans are requested only for:

- a missing product or scope decision;
- a policy escalation;
- an exhausted or failed workflow;
- final review.

### 2.3 Artifact-mediated communication

Developer and reviewer agents do not need a private conversation. They communicate through durable shared work artifacts:

- commits and the recorded head SHA;
- test, CI, and Lens evidence;
- the GitHub pull request;
- structured pull-request reviews and findings.

The visible handoff is a concrete action such as “developer updated PR” or “reviewer requested changes,” with a link to the authoritative artifact.

### 2.4 Temporary workers, reusable profiles

An agent is not a growing fictional identity. An agent profile is reusable execution configuration:

- role and purpose;
- coding runtime;
- exactly one required Agent Deck;
- permissions and limits (model/effort/budget defaults).

The GitHub repository lives on the **Issue**, not the Agent. Playbooks are chosen dynamically inside the pinned Deck; free-form external-memory refs are not an Agent field. Dealer owns managed clones and session worktrees under the execution root.

Each worker session is temporary. Learning is promoted explicitly to Agent Deck playbooks, Lexicon, or another external memory system—not accumulated implicitly in the agent profile.

### 2.5 Constrained autonomy

The workflow definition controls allowed stages, transitions, roles, gates, retry limits, and escalation conditions.

Workers may:

- complete their assigned step;
- choose an allowed outcome;
- advance to the next allowed step;
- retry within the configured limit;
- request a typed human action.

Workers may not create nodes, remove gates, rewrite workflow topology, raise limits, or merge code.

### 2.6 Video-game UI discipline, without gamification

Good game interfaces preserve deep systems while exposing only the state and actions relevant to the current decision. agent-dealer should apply that discipline:

- make the current objective, actor, intent, risk, and next action glanceable;
- reveal detail progressively instead of displaying implementation internals by default;
- make routine system behavior predictable before it occurs;
- interrupt only when the operator can make a consequential decision;
- keep controls contextual to the current state.

Do not add playful decoration, fictional character identity, experience points, ranks, health bars, loot, leaderboards, or arcade-style scoring.

## 3. User-visible concepts

The primary UI should require only five concepts.

| Concept | What the user understands | What stays internal |
|---|---|---|
| **Issue** | One goal and its complete coordination history | Run lineage and source-specific bookkeeping |
| **Workflow** | Current stage, current owner, next allowed action, rounds remaining | Scheduler and transition implementation |
| **Agent profile** | Which worker configuration fills a role | Runtime process lifecycle |
| **Artifact** | PR, commit, review, check, evidence, or final packet | Provider payloads and normalization |
| **Human action** | A decision that has stopped progress or final review | Notification delivery and state projection |

Worker sessions, workflow events, usage records, findings, and raw traces remain first-class data, but they do not become top-level navigation objects.

## 4. Target user and job

### Primary user

A developer coordinating multiple coding agents across one or more runtimes and services.

### Job to be done

> When I give a sufficiently prepared issue to agent-dealer, continue the developer–reviewer loop while I am unavailable, preserve enough evidence to understand every handoff, and return only when I must decide something or perform final review.

## 5. First release scope

### Included

- Internal issues created manually, imported from Linear, or created by a coding agent.
- One active workflow instance per issue.
- One code-defined developer–reviewer workflow.
- One repository and pull request per issue.
- Separate developer and reviewer worker sessions, profiles, and worktrees.
- Developer and reviewer may use different registered coding runtimes.
- GitHub pull requests and reviews as the shared communication surface.
- Automatic repair loops, with a default maximum of three review rounds.
- Issue conversation and concrete event history.
- Typed human actions and a global human-action queue.
- Raw runtime evidence plus normalized workflow events.
- Duration, cost, review-round, and human-wait measurements.
- Final human review packet.
- UI and programmatic control through one canonical application API, exposed to coding agents through MCP or CLI adapters.

### Excluded

- User-created workflow templates or a visual workflow builder.
- Agent-created or agent-modified workflow nodes.
- More than one active workflow per issue.
- Multiple repositories or pull requests within one issue.
- General non-code workflow handoffs.
- Direct free-form agent-to-agent chat.
- Long-lived agent persona or self-growing agent memory.
- Autonomous merge.
- Broad automation dashboards, goals, schedules, or unrelated task types.
- Team permissions and organization administration.
- Gamification or productivity scoring.

## 6. First workflow: developer–reviewer

### 6.1 Preconditions

An issue may start automatically when it has:

- a title and problem statement;
- testable acceptance criteria or an explicit task snapshot accepted by policy;
- a repository;
- a developer profile;
- a reviewer profile;
- permission to create or update a branch and draft pull request.

If required product intent cannot be normalized without guessing, create a `product_scope_decision` human action instead of starting development.

### 6.2 Workflow

1. **Prepare task snapshot**
   - Freeze the issue title, description, acceptance criteria, source links, repository, base branch, and workflow version.
   - Store the snapshot as immutable input for every review round.

2. **Prepare developer workspace**
   - Resolve the issue's GitHub repository into Dealer's managed clone and create/reuse the developer worktree under the execution root (`execution/worktrees/github.com/<owner>/<repo>/<sessionId>-developer`).
   - Attach the developer profile (runtime, required Deck, limits, permissions) to the session snapshot — no workspace root or selected playbooks.
   - The worker equips the launch-selected Deck with `bind_workspace` to that worktree cwd before other Deck/Linear use — otherwise the session is not the configured agent. Workers never start without a Deck.

3. **Develop**
   - Implement against the task snapshot.
   - Run required local tests and Lens checks.
   - Produce a concise implementation conclusion.

4. **Publish developer handoff**
   - Open or update a draft pull request.
   - Record branch, base SHA, head SHA, commit links, test evidence, and Lens evidence.
   - Emit one visible handoff: `Developer updated PR at <head SHA>`.

5. **Prepare reviewer workspace**
   - Create a separate read-only reviewer worktree at the recorded head SHA under the managed execution root.
   - Attach the reviewer profile independently from the developer profile (same required-Deck `bind_workspace` equip rule).

6. **Review**
   - Review the immutable task snapshot, diff, evidence, repository rules, and prior finding history.
   - Do not depend on private developer reasoning or conversation.

7. **Publish reviewer handoff**
   - Submit a GitHub pull-request review.
   - Store the normalized verdict and findings in agent-dealer.
   - Emit one visible handoff: `Reviewer approved <head SHA>`, `Reviewer requested changes on <head SHA>`, or `Reviewer escalated <head SHA>`.

8. **Route outcome**
   - `approved` → create the final human-review packet (`final_review`), or undraft+merge when auto-merge is enabled.
   - `changes_requested` and rounds remain → begin the next developer repair round automatically.
   - `changes_requested` and limit reached → create an `attempts_exhausted` human action.
   - `escalated` with a non-empty `productScopeQuestion` → create a `product_scope_decision` human action.
   - Bare `escalated` without `productScopeQuestion` is illegal and must be remapped before routing (see §6.4) — it must not open Resume\|Close-only `policy_escalation` for ordinary defects or truncated diffs.

9. **Final human review**
   - Present the task snapshot, PR, final SHA, checks, review history, remaining risks, duration, cost, and unresolved uncertainties.
   - On a shippable tip the human choices are **Merge** (undraft + merge the PR and mark done), return for another allowed repair round, or **Close** without acceptance — Merge and Close are distinct.
   - When auto-merge is enabled, an `approved` verdict skips this gate and the coordinator merges.

### 6.3 Pass-the-ball contract

A role change requires a durable artifact and a structured outcome. A message alone cannot advance the workflow.

| From | Required artifact | Outcome | Next owner |
|---|---|---|---|
| Intake | Immutable task snapshot | Ready | Developer |
| Developer | Updated draft PR + head SHA + evidence | Ready for review | Reviewer |
| Reviewer | Submitted PR review for the same head SHA | Approved | Human (`final_review` / auto-merge) |
| Reviewer | Submitted blocking findings for the same head SHA | Changes requested | Developer |
| Reviewer | Submitted escalation with non-empty `productScopeQuestion` | Product scope decision | Human |
| Human | Resolved typed action | Merge, repair, resume, or close | Workflow-selected role |

If the pull-request head changes while review is running, the review is stale and cannot advance the issue.

### 6.4 Reviewer output contract

Every review records:

- verdict: `approved`, `changes_requested`, or `escalated` (decision rules below);
- base SHA and reviewed head SHA;
- acceptance-criteria assessment;
- test and Lens evidence assessment;
- blocking findings;
- non-blocking observations;
- risks and uncertainties;
- `productScopeQuestion` when (and only when) verdict is `escalated`.

#### Verdict decision table (NOT-150 — source of truth for prompts and coordinator)

| Verdict | When | Next owner | Must include |
|---|---|---|---|
| `approved` | AC met for the reviewed tip; **no** `blocking` findings. `non_blocking` nits allowed | Human `final_review` (or `auto_merge` when enabled) | AC + evidence assessment; optional non_blocking findings |
| `changes_requested` | Any `blocking` finding a coding pass can address — including incomplete review because AC-critical files were omitted/truncated from the reviewer diff | Developer (automatic repair while rounds remain); else `attempts_exhausted` | Blocking findings with fingerprints |
| `escalated` | Acceptance criteria / product scope are ambiguous, contradictory, or missing a human product call — **not** ordinary code defects, **not** “diff too large” | Human `product_scope_decision` | **Required** non-empty `productScopeQuestion` |

**Illegal / must remap:**

- `escalated` without `productScopeQuestion`;
- `approved` while any finding is `blocking`;
- using escalate as a dumping ground for truncated or incomplete diffs.

**Truncated / incomplete diff policy:** the coordinator must not map truncation to bare escalate → Resume\|Close. Preferred: `changes_requested` with a stable blocking incomplete-review finding that lists omitted paths when AC cannot be certified; or keep `approved` when the visible tip still certifies AC with only `non_blocking` findings. Never the opaque escalate dead-end.

**Shippable human choices:** when a human gate remains on a shippable tip, choices must include **Merge** (complete/ship via undraft+merge) distinct from Close.

Every finding records a stable fingerprint, severity, title, rationale, evidence link, and optional file and line location. Findings remain linked across rounds as open, resolved, recurring, or superseded.

## 7. Product surfaces

### 7.1 Navigation

The primary navigation contains:

1. **Issues**
2. **Human actions**
3. **Agents**

Settings and integrations are secondary. Runs, sessions, artifacts, traces, retries, and metrics are reached through an issue rather than separate primary sections.

### 7.2 Issues list

Each issue row shows only:

- issue identifier and title;
- status;
- current owner: human, developer, reviewer, or system;
- current intent in one line;
- age or elapsed duration;
- human-action marker when blocked.

Default status vocabulary:

- `Ready`
- `Developing`
- `Reviewing`
- `Repairing`
- `Final review`
- `Needs human`
- `Done`
- `Closed`

Provider-specific and internal statuses must not expand this list.

### 7.3 Issue header

The header answers four questions within a few seconds:

1. What issue is this?
2. Where is the work now?
3. Who has the ball?
4. What happens next?

It shows:

- internal issue identifier, title, and status;
- current owner and current intent;
- next allowed action;
- review round and configured limit;
- elapsed duration and accumulated cost;
- prominent links to Linear, GitHub PR, branch, and current head SHA.

### 7.4 Issue timeline

The center of the issue is a chronological conversation containing:

- human messages;
- developer and reviewer conclusions;
- concrete workflow events;
- human-action requests and resolutions;
- final human review.

Default event rows are short and artifact-first:

```text
Developer started with Codex
Developer updated PR #142 at a84f20c                     View commit
Checks passed: 42 tests, Lens passed                     Evidence
Reviewer started against a84f20c
Reviewer requested changes: 2 blocking findings          Open review
Repair round 2 started automatically                     Why?
```

Raw prompts, tool calls, stdout, internal scheduler events, provider payloads, and full transcripts are hidden behind an evidence or trace expansion.

The issue composer adds human guidance to the issue. Guidance may influence the current worker within policy but cannot silently rewrite workflow topology or acceptance criteria.

### 7.5 Intent forecast

The right rail is a compact workflow projection, not an editable graph.

It displays:

- completed stages;
- active stage and worker profile;
- current committed action and target artifact;
- next allowed transition and its condition;
- remaining review rounds;
- locked final human review.

Example:

```text
AUTONOMY RUNNING

Now   Developer updating PR #142
Next  Run checks against the new HEAD
Then  Start reviewer if required checks pass

Round 2 of 3
```

The forecast communicates predictable autonomy. It does not require approval for each transition.

### 7.6 Human-action queue

The global queue contains unresolved decisions, not notifications.

Action types:

- `product_scope_decision`
- `policy_escalation`
- `attempts_exhausted`
- `final_review`

Every action contains:

- why progress stopped;
- the exact question or decision;
- evidence and artifact links;
- available responses;
- what will happen after each response;
- requested time and accumulated waiting time.

Routine progress stays in the issue timeline. Notable but non-blocking events may produce a transient notification. Only a human action may place an issue in `Needs human`.

When an issue requires no action, do not render a large empty-state banner inside the issue. A quiet `Autonomy running` or `No action required` status is sufficient.

### 7.7 Agent profiles

Creating a profile should require one compact form:

- profile name;
- role or purpose;
- coding runtime;
- exactly one required Agent Deck;
- permission policy;
- default limits (model / effort / budget).

Runtime, model, and advanced provider settings may use defaults and remain inspectable. Do not request workspace root, playbook selection, free-form external memory, personality, biography, avatar, relationships, or persistent personal memory.

## 8. Programmatic use

UI and coding agents operate the same product behavior through one canonical application API.

### Scenario A: human starts from UI

1. Import or create an issue.
2. Confirm missing issue inputs and select developer and reviewer profiles.
3. Start the workflow.
4. Leave agent-dealer unattended.
5. Return when the global queue contains a real action.

### Scenario B: coding agent starts or inspects work

1. A coding agent calls the agent-dealer MCP or CLI adapter with a Linear issue or structured task.
2. agent-dealer creates or resolves the internal issue idempotently.
3. The agent starts the allowed workflow or reads its current state.
4. The agent may append issue guidance, inspect evidence, or resolve only actions for which it has explicit authority.

### Required capabilities

- create or import an issue idempotently;
- retrieve issue state, owner, intent forecast, source links, and timeline;
- start the configured workflow;
- append a human or authorized agent message;
- list unresolved human actions;
- resolve a human action with a typed response;
- pause or resume an issue without rewriting workflow topology;
- retrieve artifacts, findings, evidence, usage, and raw trace references.

MCP and CLI are adapters over the canonical API. They must not implement a second workflow engine.

## 9. Data and audit requirements

### 9.1 Core records

| Record | Purpose |
|---|---|
| `issue` | Durable coordination unit and source links |
| `workflow_instance` | One issue executing one immutable workflow version |
| `worker_session` | Temporary runtime process filling one workflow role |
| `artifact` | Snapshot, PR, commit, check, review, transcript, or final packet |
| `workflow_event` | Append-only fact used to reconstruct and project history |
| `finding` | Stable reviewer finding tracked across rounds |
| `human_action` | Typed unresolved decision and its resolution |
| `usage_event` | Duration, token, and cost evidence by role and runtime |

### 9.2 Event requirements

Every workflow event records:

- issue and workflow instance;
- event type and timestamp;
- actor type and actor reference;
- workflow stage and review round;
- related worker session;
- related artifact or external URL;
- provider-native idempotency key when available;
- structured payload;
- causation event id.

The initial event vocabulary should stay small and concrete:

- `issue.created`
- `workflow.started`
- `worker.started`
- `worker.completed`
- `worker.failed`
- `pull_request.opened`
- `pull_request.updated`
- `checks.completed`
- `review.submitted`
- `repair.started`
- `human_action.requested`
- `human_action.resolved`
- `final_review.requested`
- `issue.completed`
- `issue.closed`

Additional provider events may be stored raw without appearing in the default issue timeline.

### 9.3 Evidence policy

- Structured workflow events are the coordination source of truth.
- GitHub and Linear remain authoritative for their own artifacts.
- Raw runtime transcripts and provider payloads are preserved as evidence, not interpreted as workflow state.
- Re-ingestion and webhooks must be idempotent *against a live issue*: re-importing a ticket that is still in flight never creates a second issue. Idempotency ends at the pass boundary — once every issue for a ticket is terminal, a re-import opens a new pass (NOT-141).
- A visible timeline event must link back to the structured record and authoritative artifact when one exists.

## 10. Measurements

The first release records a baseline instead of optimizing a large dashboard.

Per issue:

- total duration;
- duration by workflow stage;
- accumulated cost;
- cost by role and runtime;
- review-round count;
- human waiting time;
- whether final review was reached without intermediate human intervention.

The issue page shows duration, cost, rounds, and human wait. Aggregate analysis may initially be a query or export rather than a dedicated analytics product.

The execution-time phases, overlap and aggregation rules, evidence-quality labels, and failure vocabulary behind these measurements are defined in [EXECUTION_ANALYSIS.md](EXECUTION_ANALYSIS.md).

## 11. Functional requirements

### P0 — required for the experiment

- [ ] An internal issue persists across all developer and reviewer sessions.
- [ ] One issue can run the hardcoded developer–reviewer workflow end to end.
- [ ] Developer and reviewer use separate profiles and worktrees.
- [ ] Every review is bound to an exact head SHA.
- [ ] PR updates and submitted reviews advance the workflow through structured outcomes.
- [ ] Blocking findings automatically start a repair round while attempts remain.
- [ ] A maximum review-round limit is enforced by the coordinator, not the worker.
- [ ] The workflow reaches final human review without routine human approval.
- [ ] No automatic merge occurs.
- [ ] The issue timeline reconstructs concrete handoffs with artifact links.
- [ ] A human action stops progress and appears both inline and in the global queue.
- [ ] The same issue state and controls are available to the UI and coding agents.
- [ ] Duration, cost, rounds, human wait, worker sessions, artifacts, and raw evidence are stored.

### P1 — after the first loop works

- [ ] Agent-profile creation uses compact defaults and advanced disclosure.
- [ ] The issue list shows current owner and intent without opening the issue.
- [ ] Findings are reconciled across review rounds by stable fingerprint.
- [ ] The final review packet summarizes resolution of every blocking finding.
- [ ] A human may pause or resume an issue without changing workflow topology.
- [ ] External webhook replay and duplicate delivery are idempotent.

## 12. Experience acceptance tests

### Five-second state test

Given any active issue, a first-time viewer can identify within five seconds:

- the current stage;
- who has the ball;
- what that actor is doing;
- what artifact is being changed or reviewed;
- what happens next;
- whether human action is required.

### Unattended repair test

Given a prepared issue, a developer profile, a reviewer profile, and a review that requests changes, agent-dealer starts a repair round and a fresh review without human input, up to the configured limit.

### Artifact handoff test

Given no direct agent-to-agent chat, a reviewer can perform a complete review using the task snapshot, exact diff, repository rules, test evidence, and prior finding history.

### Human-action precision test

Routine state transitions never enter the human-action queue. Every queued item contains a decision the user can act on and clearly explains what resumes afterward.

### Audit reconstruction test

Given a completed issue, the system can reconstruct every worker session, reviewed SHA, review verdict, finding status, transition, human decision, duration, and cost.

## 13. Migration from the current run-oriented product

The existing implementation should be evolved rather than discarded.

| Current concept | Issue-centric role |
|---|---|
| `runs` row | `worker_session` or legacy single-session issue input |
| run lineage | initial source for creating an `issue` and workflow history |
| run artifacts | retained as issue-linked artifacts |
| plan/execution/review statuses | projected into the smaller issue status vocabulary |
| agent record | reusable agent profile |
| Linear external id | issue source link and idempotency key |
| operation lanes | replaced by issue list, issue timeline, and intent forecast |

Migration must preserve existing artifacts and audit history. Old runs may be represented as single-session legacy issues when a workflow cannot be reconstructed safely.

## 14. Rollout and learning plan

### Phase 1 — event spine

- Introduce internal issues, workflow instances, worker sessions, events, findings, and human actions.
- Project existing runs into issues without changing the current UI.
- Verify event completeness and idempotency using synthetic developer–reviewer rounds.

### Phase 2 — coordinator

- Implement the hardcoded workflow and exact-SHA handoffs.
- Run real issues through separate developer and reviewer profiles.
- Measure where the coordinator still waits for manual intervention.

### Phase 3 — issue interface

- Ship Issues, Human actions, and Agents navigation.
- Add issue timeline, artifact links, and intent forecast.
- Run the five-second state test with completed and active issues.

### Phase 4 — refine from data

- Compare duration, cost, review rounds, human wait, and intervention causes.
- Remove timeline events and controls that do not change understanding or decisions.
- Add another maintainer-defined workflow only after the developer–reviewer workflow reveals a reusable handoff contract.

## 15. Open decisions for the experiment

These do not block the PRD, but implementation should record the chosen answer.

1. Is issue pause a persistent workflow state, or an operator control that interrupts only the active worker session?
2. Which reviewer conditions qualify as `policy_escalation` in the first hardcoded policy?
3. Does final human rejection consume another review round or require an explicit limit override?
4. What is the smallest structured implementation conclusion that improves final review without duplicating the PR description?
5. Should the default intent forecast show one next action or the next two conditional actions?
6. Which raw runtime evidence is retained indefinitely, and which may follow a retention policy after normalized events are stored?

## 16. Definition of success

The rework succeeds when a prepared software issue can move from developer to reviewer, through repair rounds, and into final human review while the operator is absent—and when the operator can return, understand the entire state in seconds, and trust why the workflow advanced or stopped.

The product should feel deep because its coordination is reliable, not because its interface exposes every underlying mechanism.
