# Outbound Soft Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unblock execute-phase `call_service_tool` so non-Slack/email deck writes can complete, while keeping draft → Approve & send as the preferred path for messages.

**Architecture:** Soft allow on execute only; plan/reflect/qa still deny. Prompt prefers draft. Schema adds `service_tool_call` / `service_draft` for optional gated delivery.

**Tech Stack:** TypeScript monorepo, zod schemas in `@agent-dealer/shared`, node:test, Claude CLI `--allowedTools` / `--disallowedTools`.

## Global Constraints

- Do not reintroduce unconditional deny on execute.
- Deliver path stays verbatim `toolCall` via deck MCP.
- Body-match/edit semantics remain Slack/email-specific.

---

### Task 1: Schema — `service_tool_call` / `service_draft`

**Files:**
- Modify: `packages/shared/src/outbound-draft.ts`
- Modify: `packages/shared/src/outbound-draft.test.ts`
- Modify: `packages/shared/src/index.ts` (`ArtifactKind`)

- [x] Write failing tests for parse + `outboundDraftKind("service_tool_call") === "service_draft"`
- [x] Extend enum, kind helpers, skip body-match for `service_tool_call`
- [x] Run `npm test -w @agent-dealer/shared`

### Task 2: Runner soft allow on execute

**Files:**
- Modify: `packages/server/src/runners/claude-args.ts`
- Modify: `packages/server/src/runners/claude.test.ts`

- [x] Rewrite tests: execute allows + does not deny; plan/reflect/qa still deny
- [x] Implement allowlist + conditional deny
- [x] Run server runner tests

### Task 3: Prompt soft preference

**Files:**
- Modify: `packages/server/src/runners/prompts.ts`
- Modify: `packages/server/src/runners/prompts.test.ts`

- [x] Update test expectations (no “blocked”; prefer draft; allow direct tool for service writes)
- [x] Rewrite `outboundDraftContractSection`
- [x] Run prompts tests

### Task 4: UI + docs

**Files:**
- Modify: `apps/web/src/components/drawer/OutboundDraftCard.tsx`
- Modify: `apps/web/src/components/drawer/ResultReviewPanel.tsx`
- Modify: `apps/web/src/components/drawer/DoneReviewPanel.tsx`
- Modify: `README.md`, `docs/PRD_SEND_GATE.md`, `CHANGELOG.md`

- [x] Include `service_draft` in pending-draft lookup
- [x] Neutral outbound copy for non-message action types
- [x] Document soft gate

### Task 5: Verify

- [x] `npm test -w @agent-dealer/shared` and server package tests for touched areas
- [ ] `npm run flow:verify` if API up — skipped (API not listening)