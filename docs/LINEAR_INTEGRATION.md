# Linear integration

Linear is the primary intake path for agent-dealer: issues assigned to you appear in the **Inbox**, you promote them one-by-one into **Operations**, approve the plan, and the agent executes with human gates preserved.

**Manual tasks** remain for testing; they are not the main workflow.

## Architecture

```mermaid
flowchart TB
  subgraph linear [Linear]
    Issues[Assigned issues]
  end
  subgraph dealer [agent-dealer]
    Inbox[Inbox UI + config]
    API[REST API]
    Ops[Operations lifecycle]
    Sync[Linear write-back]
  end
  subgraph agent [Orchestrator agent optional]
    AgentCLI[Claude/Cursor + scripts]
  end
  Issues -->|GraphQL read| Inbox
  Issues -->|GraphQL read| API
  Inbox -->|promote one-by-one| Ops
  AgentCLI -->|REST not cron| API
  API -->|promote + autoAgent rules| Ops
  Ops -->|plan / review / done| Sync
  Sync -->|comment + status| Issues
```

## Principles

| Topic | Behavior |
|-------|----------|
| **Intake** | Human or agent promotes issues — no server auto-cron enqueue |
| **Linear read** | Server GraphQL (`linear-inbox.ts`) — not Agent Deck MCP for the queue |
| **API key** | `LINEAR_API_KEY` env-only — never stored in SQLite |
| **Settings** | Filters in SQLite; editable in Inbox → Linear settings. `LINEAR_STATE_FILTER` / `LINEAR_TEAM_ID` env override saved values when set |
| **Automation** | REST API first; orchestrator agents call promote/resolve-agent |
| **Write-back** | Non-blocking comments + status at plan / review / done milestones |

## Configuration

### Environment (secrets + live filter overrides)

| Variable | Role |
|----------|------|
| `LINEAR_API_KEY` | Required for Linear API (Personal API key) |
| `LINEAR_STATE_FILTER` | **Live override** when set — inbox uses this instead of saved filter |
| `LINEAR_TEAM_ID` | **Live override** when set — inbox uses this instead of saved team |
| `AGENT_DEALER_WEB_URL` | Optional — links in Linear comments (dev default `http://localhost:3222`, prod `http://localhost:2222`) |

### Persisted settings (`intake_settings`)

| Key | Default | Notes |
|-----|---------|-------|
| `linear.stateFilter` | `["Todo"]` | Saved filter; overridden by `LINEAR_STATE_FILTER` env when set |
| `linear.teamId` | null | Saved team; overridden by `LINEAR_TEAM_ID` env when set |
| `linear.assigneeMe` | true | Filter to API key owner |
| `linear.defaultAgentId` | null | Pre-select in Inbox UI |
| `linear.syncEnabled` | true | Master toggle for write-back |
| `linear.routingRules` | `[]` | Label → agentId rules for `autoAgent` |

Configure via **Inbox → Linear settings** or `PATCH /api/intake/linear/config`.

## Workflow

1. **Inbox** — Issues matching filters (default: Todo, assigned to me) appear as candidates.
2. **Promote** — Pick agent → **Kick plan** → run enters Operations at `plan_pending`.
3. **Plan gate** — Review draft → **Approve plan** → Linear comment + status **In Progress**.
4. **Execute** — Agent runs → transitions to **review** → Linear comment + status **In Review**.
5. **Done** — **Approve done** → Linear comment + status **Done**.

Promote is blocked (409) if an active run already exists for the same Linear issue (`source=linear`, `external_id=issue.id`).

## REST API (orchestrator agents)

Base URL: `http://127.0.0.1:3221` (development) or `http://127.0.0.1:2221` (production). See [PROD_SETUP.md](PROD_SETUP.md).

### Connection & config

```bash
# Connection test (viewer from API key)
curl -s http://127.0.0.1:2221/api/intake/linear/status | jq

# Read config (non-secret)
curl -s http://127.0.0.1:2221/api/intake/linear/config | jq

# Update filters
curl -s -X PATCH http://127.0.0.1:2221/api/intake/linear/config \
  -H 'Content-Type: application/json' \
  -d '{"stateFilter":["Todo","Backlog"],"assigneeMe":true,"syncEnabled":true}' | jq
```

### List inbox

```bash
curl -s http://127.0.0.1:2221/api/intake/linear | jq '.candidates[] | {id, identifier, title}'
```

### Resolve agent (preview routing)

```bash
curl -s -X POST http://127.0.0.1:2221/api/intake/linear/ISSUE_UUID/resolve-agent | jq
# → { "agentId": "...", "reason": "label:content → Notes agent" }
```

Routing order: explicit `agentId` on promote → label rules → `defaultAgentId` → first healthy agent with workspace.

### Promote issue

```bash
# Explicit agent
curl -s -X POST http://127.0.0.1:2221/api/intake/linear/ISSUE_UUID/promote \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"AGENT_UUID"}' | jq

# Auto-resolve agent
curl -s -X POST http://127.0.0.1:2221/api/intake/linear/ISSUE_UUID/promote \
  -H 'Content-Type: application/json' \
  -d '{"autoAgent":true}' | jq
```

Requires exactly one of `agentId` or `autoAgent: true`.

## Future MCP tool shapes (spec only)

No agent-dealer MCP server in this pass. Orchestrator agents may wrap REST as:

| Tool | Maps to |
|------|---------|
| `list_linear_inbox` | `GET /api/intake/linear` |
| `promote_issue` | `POST /api/intake/linear/:issueId/promote` |
| `resolve_agent` | `POST /api/intake/linear/:issueId/resolve-agent` |

## Out of scope

- Server-side auto-cron enqueue (Phase D)
- agent-dealer MCP server binary
- LLM-based agent creation

## Related docs

- [Agent profiles](AGENT_PROFILES.md) — workspace binding for promoted runs
- [Data model](DATA_MODEL.md) — runs, artifacts, `external_label`
