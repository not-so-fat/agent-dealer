# Outbound soft gate — design

**Date:** 2026-07-13  
**Status:** approved  
**Incident:** Linear ticket creation stranded — `call_service_tool` denied in every dealer phase while draft schema only allowed `slack_message` | `email`.

## Decision

Soft gate for **execute**: agent may invoke `call_service_tool` mid-run. Draft → Approve & send remains the **preferred** path for Slack/email (and other outward writes when the agent chooses to draft). Plan / reflect / qa keep the structural deny.

## Changes

1. **Runner** — execute allowlist includes `mcp__agent-deck__call_service_tool`; execute does not pass `--disallowedTools` for that tool; plan/reflect/qa still deny it.
2. **Prompt** — stop claiming the tool is blocked; prefer draft JSON for Slack/email; allow direct `call_service_tool` for non-message service writes (Linear, GitHub, Docmost, …).
3. **Schema** — add `actionType: "service_tool_call"` → artifact kind `service_draft`; deliver path unchanged (verbatim `toolCall`). Body-match / body-edit apply only to Slack/email message action types.
4. **UI** — treat `service_draft` like other outbound drafts; copy not message-only.
5. **Docs** — README + send-gate PRD note the soft preference vs hard deny; CHANGELOG.

## Non-goals

Hard category-split deny, MCP intercept shim, deck read/write tool split.
