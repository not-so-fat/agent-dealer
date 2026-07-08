---
status: implementation-ready
authoring_playbooks: pb_ai_codegen_prd, pb_product_principle
related:
  - docs/PRD_V0.md
  - docs/PRD_PLAN_QUESTIONS.md
---

# agent-dealer — Outbound Send Gate PRD (draft → review → deliver)

**One-liner:** Outward-facing messages become reviewable drafts — the agent proposes the exact payload, the human approves it in the review lane, and the server sends the approved bytes; nothing leaves the machine before review.

**Status:** implementation-ready · **Doc role:** feature PRD (implements the draft → gate → send subset of `PRD_V0.md` §7)
**Codegen load path:** `docs/PRD_SEND_GATE.md`
**Success criteria (2 weeks after ship):** 100% of outbound sends trace to a human-approved draft artifact (every `send_receipt` links one); zero outbound messages originate from an execute-phase transcript (stream-trace audit); ≥ 1 real Slack task dogfooded through draft → approve → send.

---

## 1. Product overview

Today a task like "message X about Y on Slack" sends **during the execute phase**, and the human reviews the result only after the message has landed. The review gate exists (`running → review → done`) but outward actions escape it. Worse, the send happened through the deck MCP even though `call_service_tool` is **not** in the execute `--allowedTools` list (`packages/server/src/runners/claude.ts:99`) — user-scope permission settings merge into spawned `claude -p` runs and widen the allowlist. Allowlist-by-omission is not enforcement.

This feature makes "send" a lifecycle stage owned by the server instead of a capability the agent has: (1) send-capable tools are **explicitly denied** in every phase, (2) the execution prompt contract requires outward actions to end as a structured **draft artifact**, (3) the review card renders the draft and **Approve** becomes **Approve & send**, (4) a server-side deliver step sends the stored payload **verbatim** and persists a receipt. `PRD_V0.md` §7 already names this pattern ("draft → gate → send"); the `slack_draft` / `email_draft` artifact kinds already exist unused in `@agent-dealer/shared`.

The mid-run pause/resume gate flow from `PRD_V0.md` §7 is deliberately **not** built (see §10): it holds a live subprocess and a concurrency slot while the human is away, which conflicts with the overnight-queue use case. The stage-gate design gets the same fidelity guarantee (reviewed bytes are sent bytes) because the server, not a resumed agent, performs the send.

## 2. Target users & roles

| Role | Goal | v1 surface |
|------|------|------------|
| Operator (existing single role) | Delegate communication tasks knowing nothing outward-facing fires without their eyes on the exact payload | Dashboard review lane, run detail |

No new roles. Gating model from `PRD_V0.md` unchanged in direction — this PRD widens *what* the result-review gate controls (it now releases outward actions), never *who* approves.

## 3. User stories (testable)

**US-1 — Review the Slack message before it is sent** *(v1)*
As the operator, I want the agent's Slack message shown to me as a draft in the review lane, so that I approve the exact payload before anything reaches Slack.
- [ ] A communication task's execute phase produces a `slack_draft` artifact (status `pending`) and the run lands in `review` with **nothing sent**
- [ ] The review card shows target + body prominently and the exact proposed tool call (collapsible)
- [ ] **Approve & send** sends the stored payload verbatim, persists a `send_receipt`, and moves the run to `done`
- [ ] The message that lands in Slack is byte-identical to the approved draft body

**US-2 — Revise the draft without sending** *(v1)*
As the operator, I want Retry with feedback to send the agent back to redraft, so that a wrong message is fixed instead of sent.
- [ ] Retry marks the pending draft `rejected`; nothing is sent
- [ ] The retry lineage run produces a fresh draft that re-enters review

**US-3 — Sends are impossible during execution** *(v1)*
As the operator, I want send capability structurally removed from agent phases, so that a prompt-ignoring agent still cannot send.
- [ ] `--disallowedTools` includes `mcp__agent-deck__call_service_tool` for plan, execute, and reflect invocations
- [ ] A probe run that attempts `call_service_tool` in execute shows a permission denial in its stream trace — including when user-scope settings allow `mcp__agent-deck__*`

**US-4 — Failed sends don't lose the run** *(v1)*
As the operator, when the deck is down at approve time, I want the run to stay reviewable, so that I can retry the send without redoing the work.
- [ ] Deliver failure keeps the run in `review`, keeps the draft `pending`, and surfaces the error on the card
- [ ] Approving again retries the send; a draft is never sent twice (§7.2 status transition is atomic)

**US-5 — Gate ticket status changes and external publishing** *(deferred)*
Reason: no concrete incident yet and no deck service wired for these actions; shipping Slack end-to-end first proves the envelope. Path back: add `actionType` values to the §7.1 enum and a deliver dispatch branch — draft extraction, review UI, and receipt flow are reused unchanged.

## 4. Features & requirements

### F1 — Send-capability lockdown (runner)

| Req ID | Requirement | Acceptance |
|--------|-------------|------------|
| F1.1 | All three phase invocations in `runners/claude.ts` pass `--disallowedTools "mcp__agent-deck__call_service_tool"`. Deny rules beat allow rules from every settings layer — this closes the user-settings bypass found in the incident. | Args unit/snapshot test; probe run per US-3 acceptance |
| F1.2 | Execute allowlist adds `mcp__agent-deck__list_service_tools` (read-only discovery — the agent needs real tool names to propose a valid §7.1 `toolCall`). | Snapshot test; drafting smoke produces a toolCall whose `toolName` exists on the bound deck |
| F1.3 | For `taskCategory ∈ {communication, email}`, `Bash` is removed from the execute allowlist (closes the curl-with-env-credentials side channel where the category makes Bash unnecessary). README trust-scope table updated. | Snapshot test keyed by category; README row |

### F2 — Outbound draft contract (prompt + extraction)

| Req ID | Requirement | Acceptance |
|--------|-------------|------------|
| F2.1 | `buildExecutionPrompt` gains an outbound-action contract section (all categories): any outward-facing action (Slack/chat message, email) must NOT be performed; instead end the reply with exactly one fenced ```json block matching §7.1. At most one outbound draft per run (see §12). | Prompt snapshot test; real-call smoke returns a §7.1-valid block |
| F2.2 | `extractOutboundDraft(events)` in `runners/stream-json.ts` parses the last fenced JSON block matching §7.1 (shared zod schema), strips it from the stored result markdown, and persists a `slack_draft` / `email_draft` artifact (§7.2, status `pending`) keyed by `actionType`. Absent block ⇒ no artifact (plain review, approve = plain done). Invalid block ⇒ no artifact + `outbound_draft_invalid` run event. | Unit tests: valid / absent / malformed / JSON-in-prose false positive; degrade path never sends |
| F2.3 | New artifact kind `send_receipt` in `@agent-dealer/shared` (§7.3). | Schema + migration-free enum addition; type check green |

### F3 — Review & deliver (server)

| Req ID | Requirement | Acceptance |
|--------|-------------|------------|
| F3.1 | `POST /api/runs/:id/approve` (routes/index.ts:470): when a `pending` draft exists, run the deliver step **before** the `review → done` transition. Success ⇒ draft status `sent` + `send_receipt` artifact + transition. Failure ⇒ run stays `review`, draft stays `pending`, error persisted as run event and returned to the UI. | Route tests: approve-with-draft happy path, deliver-failure path, approve-without-draft unchanged |
| F3.2 | Deliver adapter in `adapters/agent-deck.ts`: MCP client against the deck MCP (`getAgentDeckMcpUrl()`, `:1110/mcp`) invoking `call_service_tool` with the stored §7.1 `toolCall` **verbatim** — no re-generation, no agent session. | Unit test asserts payload passed byte-identical from artifact to MCP call (adapter boundary mocked) |
| F3.3 | Send-once guard: draft status transition `pending → sent` is atomic (single SQLite update guarded by current-status predicate); concurrent/second approve while a send is in flight returns 409. | Route test: double-approve race yields one send |
| F3.4 | `POST /api/runs/:id/retry` marks all `pending` drafts on the run `rejected` before creating the lineage run. | Route test; US-2 acceptance |

### F4 — Dashboard

| Req ID | Requirement | Acceptance |
|--------|-------------|------------|
| F4.1 | Review card gains an outbound section below the result reading surface, inside the decision cluster: summary target + body rendered prominently, exact `toolCall` JSON collapsible, and the primary action relabeled **Approve & send** when a pending draft exists. | UI renders from snapshot alone; approve-without-draft keeps the plain **Approve done** label |
| F4.2 | Deliver failure renders the error inline on the card with the retry-send affordance (re-approve). | Visible after a mocked failure |
| F4.3 | Run detail timeline shows the draft artifact and, after send, the `send_receipt` (timestamp + raw tool result / permalink when present). Done lane card gets a "sent" badge. | Timeline rows present for a dogfood run |
| F4.4 | Snapshot payload: per-run `pendingSendCount` so the review lane can flag "will send on approve" without an artifact fetch. | Snapshot contract test |

### F5 — Verification

| Req ID | Requirement | Acceptance |
|--------|-------------|------------|
| F5.1 | Standalone PoC script `scripts/poc/agent-deck-send.ts`: one `call_service_tool` Slack post through the deck MCP from a plain Node MCP client. Runs **before** F3 wiring (integration-PoC-first). | Script exits 0 and a message lands in a test channel |
| F5.2 | New flow-verify gates: (a) execute yields draft ⇒ run in `review` with `pendingSendCount = 1` and zero deliver calls; (b) approve ⇒ deliver called with byte-identical payload (adapter mocked) ⇒ `done` + receipt; (c) deliver failure ⇒ run stays `review`; (d) retry ⇒ draft `rejected`. | Gates green in CI via `npm run flow:verify` |

## 5. Pricing model

Not applicable — agent-dealer does not host, proxy, or bill. (Section retained to keep scaffold numbering.)

## 6. Design principles

- **Approved bytes are sent bytes.** The server sends the stored `toolCall` verbatim; no agent runs between approval and send (load-bearing: F3.2).
- **Send is a server capability, not an agent capability.** Enforcement is structural (deny rules, F1.1), not prompt-based; the prompt contract only shapes *how* the draft arrives, never *whether* sending is possible.
- **No draft ⇒ no send.** Every degrade path (missing block, invalid block, parse bug) converges on "nothing leaves the machine" (load-bearing: F2.2).

## 7. Cross-cutting contracts

### 7.1 Outbound draft block (agent output, end of execute reply)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "agent-dealer/outbound-draft-block.json",
  "type": "object",
  "required": ["actionType", "summary", "toolCall"],
  "additionalProperties": false,
  "properties": {
    "actionType": { "enum": ["slack_message", "email"] },
    "summary": {
      "type": "object",
      "required": ["target", "body"],
      "additionalProperties": false,
      "properties": {
        "target": { "type": "string", "maxLength": 120 },
        "body": { "type": "string", "maxLength": 4000 }
      }
    },
    "toolCall": {
      "type": "object",
      "required": ["serviceName", "toolName", "arguments"],
      "additionalProperties": false,
      "properties": {
        "serviceName": { "type": "string", "maxLength": 120 },
        "toolName": { "type": "string", "maxLength": 120 },
        "arguments": { "type": "object" }
      }
    }
  }
}
```

Server-side rule (not expressible in schema): the message text inside `toolCall.arguments` must equal `summary.body`; on mismatch the draft is persisted with an `outbound_draft_mismatch` run event and the UI shows the raw `toolCall` expanded by default.

### 7.2 `slack_draft` / `email_draft` artifact `contentJson`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "agent-dealer/outbound-draft-artifact.json",
  "type": "object",
  "required": ["draft", "status"],
  "additionalProperties": false,
  "properties": {
    "draft": { "$ref": "agent-dealer/outbound-draft-block.json" },
    "status": { "enum": ["pending", "sent", "rejected"] },
    "sentAt": { "type": "string", "format": "date-time" },
    "rejectedAt": { "type": "string", "format": "date-time" }
  }
}
```

Status transitions: `pending → sent` (deliver success, atomic per F3.3) and `pending → rejected` (retry per F3.4) only. `sent` and `rejected` are terminal.

### 7.3 `send_receipt` artifact `contentJson`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "agent-dealer/send-receipt-artifact.json",
  "type": "object",
  "required": ["draftArtifactId", "sentAt", "toolResult"],
  "additionalProperties": false,
  "properties": {
    "draftArtifactId": { "type": "string", "format": "uuid" },
    "sentAt": { "type": "string", "format": "date-time" },
    "toolResult": { "type": "object", "description": "Raw call_service_tool result" },
    "permalink": { "type": "string", "format": "uri" }
  }
}
```

## 8. Technical constraints & preferences

- TypeScript monorepo; zod mirrors of §7 live in `packages/shared/src` and are the runtime source of truth (JSON Schemas above are the contract of record; zod must stay equivalent).
- No new run statuses; `review → done` transition and its late-result guards unchanged — deliver is a pre-transition step inside the existing approve route.
- Runner changes confined to `runners/claude.ts` (flags) and `runners/prompts.ts` (contract section); extraction follows the proven plan-triage pattern in `runners/stream-json.ts`; deliver in `adapters/agent-deck.ts` next to the existing REST helpers; MCP client via `@modelcontextprotocol/sdk` over streamable HTTP to `:1110/mcp`.
- **Codegen load path:** `docs/PRD_SEND_GATE.md`. Repo-specific UI chrome stays in `.cursor/rules/agent-dealer.mdc`.

## 9. Non-functional requirements

| NFR | Target | Measurement |
|-----|--------|-------------|
| Enforcement completeness | 0 outbound sends from any agent phase | Stream-trace audit over all runs in the first 2 weeks after ship (grep traces for `call_service_tool` tool_use outside deliver) |
| Send fidelity | 100% of sends byte-identical to approved draft | Asserted in F3.2 unit test and F5.2 gate (b) on every CI run |
| Draft extraction success | ≥ 90% of communication-task runs yield a §7.1-valid block | `outbound_draft_invalid` event rate over the first 10 real communication runs |
| Deliver latency | Approve & send → receipt persisted ≤ 10 s (deck healthy) | Timed in F5.2 gate (b) and one real dogfood run |

## 10. Out of scope

- **Mid-run pause/resume action gates** (`PRD_V0.md` §7 gate flow) — holds a subprocess and a concurrency slot across human latency; conflicts with overnight queues. Path back: drafts, review UI, and receipts from this PRD are reused; only the runner changes (`--permission-prompt-tool` interception writing the same §7.2 artifact).
- **Removing `Bash` from code-task execution** — a real but separate trade-off; code tasks need Bash. This PRD closes it only where free (F1.3).
- **Per-run gate configuration UI** — `Run.approvalGatesJson` already exists in the schema; v1 hardcodes require-approval for all §7.1 actionTypes. Path back: read the field in the approve route before requiring a pending-draft review.
- **`update_ticket_status` / `publish_external` actionTypes** — US-5, deferred with path back defined there.
- **Multiple outbound drafts per run** — v1 contract is one block; extra blocks ignored with a warning event (revisit if a real task needs a fan-out send).
- **Linear write-back of send events** — existing linear-sync scope unchanged.

## 11. Milestones

| Week | Exit criteria |
|------|---------------|
| 1 | F5.1 PoC script sends to a test channel; F1 + F2 landed (deny flags, prompt contract, extraction, `send_receipt` kind); unit tests green; a real communication-task run produces a `pending` draft and sends nothing |
| 2 | F3 + F4 landed; four F5.2 flow-verify gates green in CI; one real dogfood task completes draft → **Approve & send** → receipt; README trust table and CHANGELOG updated |

## 12. Open decisions

| Question | Default if undecided | Owner |
|----------|----------------------|-------|
| Deliver transport | MCP client → deck `:1110/mcp` `call_service_tool` (no Agent Deck changes needed); switch to a deck REST proxy endpoint only if MCP session overhead proves annoying | Longhao |
| Draft authorship of the tool call | Agent proposes the full `toolCall` (it has `list_service_tools` context); server sends verbatim; §7.1 mismatch rule guards summary/args drift | Longhao |
| Per-draft veto on approve | None in v1 — approve sends the (single) pending draft; to veto, use Retry with feedback | Longhao |
| Email delivery in v1 | `email_draft` renders in review; deliver attempts only if the bound deck has an email-capable service, otherwise the card shows "draft only — no send service on deck" and approve completes without sending | Longhao |

## 13. How to use this PRD

- **Engineers / AI codegen:** load this file; implement in order F5.1 → F1 → F2 → F3 → F4 → F5.2 (PoC before product wiring). Every Req ID's acceptance column is the definition of done; §7 schemas are copy-paste contracts — do not restate shapes inline in code comments.
- **Verification:** extend `scripts/flow-verify.ts` with the four F5.2 gates; mock at the deliver-adapter boundary as existing gates mock the runner boundary. The US-3 enforcement probe needs one real spawned run — pair it with the existing `flow:doc` smoke.
- **Review:** the human approval model of `PRD_V0.md` still governs; this PRD extends result review to release outward actions and changes nothing about plan approval.

---

## Appendix — source notes

| Source | Captured as |
|--------|-------------|
| Brainstorming session 2026-07-07 (incident report + approach A decision with Longhao; scope: all outward actions, Slack first) | §1 overview, §3 stories, §6 principles, §10 negative space |
| Run-log inspection `~/.agent-dealer-dev/.temporal/logs/` (send occurred via deck MCP despite allowlist omission) | §1 bypass finding, F1.1 deny-rule rationale |
| `packages/server/src/runners/claude.ts` (phase allowlists), `runners/prompts.ts` (prompt contracts), `runners/stream-json.ts` (triage extraction pattern), `routes/index.ts:470` (approve), `adapters/agent-deck.ts` (deck REST/MCP URLs) | §4 requirements, §8 constraints |
| `docs/PRD_V0.md` §7 (action-level gates, draft → gate → send), artifact kinds table | §1 lineage, §7 artifact reuse, §10 mid-run gate deferral |
| `docs/PRD_PLAN_QUESTIONS.md` | Scaffold precedent (fenced-block contract, flow-verify gate style) |
