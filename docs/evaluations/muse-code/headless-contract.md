# NOT-177: Muse Code headless, contributor-tier, and orchestration contract

Go/no-go spike for a native Muse Code runtime adapter. Everything below was observed by running
the installed CLI (not Codex, never `--yolo`) against the operator's contributor-tier model.
Sanitized captures: `packages/server/src/runners/fixtures/muse-code/` (index: `manifest.json`).
No production Runtime/profile/spawn code was changed.

## Conclusion

**`blocked_by_named_capability`**

Named capability: **`mcp_tool_allowlist_enforcement`** — Muse Code 1.3.0-R3401.1 stores but does
not enforce per-tool MCP `enabled_tools` / `disabled_tools` (its own migration guide says so;
probe 8 confirmed it: an excluded tool still executed). Agent Deck has no server-side read-only
mode either (deck headers select a deck and workspace only). A reviewer that has Agent Deck
configured — which Dealer requires — can therefore always reach `call_service_tool`, the outbound
mutation path, so the ticket's "reviewer cannot perform outbound mutation" requirement cannot be
met mechanically. A second, smaller gap is that `cron_create` cannot be disabled (see probe 9).

Everything else needed for a **developer** adapter worked (probes 1–6, 8, 9, 10), so this is a
narrow, named block, not a `do_not_integrate`. Unblock paths, none of which were probed:

1. Muse enforces `enabled_tools`/`disabled_tools` for `mcpServers` entries (then re-run probe 8).
2. Dealer ships a filtering stdio MCP proxy as the only configured server (new production
   surface; needs its own ticket and threat model).
3. Reviewer runs with no MCP server, with playbook/deck text fetched by Dealer and put in the
   prompt. This relaxes acceptance criterion 8 for the reviewer and still leaves `cron_create`.

## Pins

| Item | Value |
|------|-------|
| Muse Code | `1.3.0 (1.3.0-R3401.1)`, channel `muse-stable`, release `state: public` |
| Binary | `~/.local/bin/muse-bin-1.3.0-R3401.1`, sha256 `20c5eb32f6aea741adac032c14be2f1897432caaf35144c33279a4d2b0bd8840` |
| Model | `muse-spark-1.3-contributor` (catalog: provider `meta`, profile `tbh`, `is_default: true`, released 2026-09-02, context 1,007,997, output 128,000; description "Your content, including inter-session messages, may be used for product improvement.") |
| Reasoning effort | default `high` (catalog tiers: minimal, low, medium, high, xhigh, max; CLI also accepts `none`, `ultra`). Not varied. |
| Auth | `muse login` (Meta account, stored in `$XDG_CONFIG_HOME/muse/auth.json`; contents never read). `META_API_KEY` in the environment takes priority. |
| Plan | **Not observable.** No plan/tier field appears in the JSONL, the session log, or the model catalog (`cost: null`). The only tier signal is the `-contributor` model id. |

Pinning gotchas that the adapter must handle:

- `~/.local/bin/muse` is a launcher script that checks for updates hourly and re-execs
  `muse-bin-<version>`. Set `MUSE_NO_AUTO_UPDATE=1` or the pinned version can change mid-fleet.
- **An unknown `--model` id is accepted and the run exits 0** (`--model muse-spike-x` returned a
  reply). `run.model.configured.model_id` only echoes the request. The server-confirmed model is
  `model_completed.model` in the on-disk session log; that event was absent for the bogus id.
  The adapter must require `model_completed.model == "muse-spark-1.3-contributor"`.
- Passing `--model` explicitly reports `profile_id: null`; omitting it reports `profile_id: "tbh"`.
  Always pass `--model`.
- Contributor-tier content may be used for product improvement (catalog description). That is a
  data-handling decision for the operator, and every prompt in this spike was synthetic.

## Turn completion is not task correctness

`run.terminal.completed` and exit code 0 mean only that the model stopped. They do **not** mean the
task succeeded: `02-tool-failure` and `05-06-developer-posture` both finish `completed`/exit 0 with
failed tool calls (`tool.result.correlation_facts.outcome == "failure"`) and a model that
summarises them. The final text is model prose, not a verified result. The adapter must treat
`completed` as "turn ended", and Dealer's own checks (git diff, tests, PR/review state, the
`tool.result` failure counts) decide correctness. The only failing-exit outcomes seen were
`run.terminal.failed` (step cap, auth) and startup failures.

## Command contract (recommended postures)

Common flags: `muse exec --json --no-foreign-personal-context --model muse-spark-1.3-contributor
--approval-mode never --approval-judge off --sandbox-network restricted --disable-web-tools
--session-id <UUID> --max-model-steps <N> "<prompt>"` run with `MUSE_NO_AUTO_UPDATE=1`, a
per-attempt `XDG_CONFIG_HOME` and `XDG_DATA_HOME` (both `0700`), a symlinked `auth.json`, cwd = the
git worktree, and **without** `--trust-workspace`, `--yolo`, `--disable-sandbox`,
`--disable-approval`, `-w/--worktree`, `--preset`, `--agents`.

- Developer: the common flags.
- Reviewer: common flags plus `--disable-write --disable-shell`.

Per-attempt `settings.json` (`fixtures/muse-code/settings/recommended.settings.template.json`):

```json
{
  "schema_version": 1,
  "run": { "workflow_trigger_mode": "off", "subagent_delegation_mode": "off" },
  "runtime_capabilities": { "plugin:tbh-reminders:reminder:<name>": { "enabled": false } },
  "mcpServers": { "agent-deck": { "type": "streamable-http", "url": "http://127.0.0.1:1110/mcp",
    "headers": { "x-agent-deck-deck-id": "<DECK_ID>", "x-agent-deck-workspace": "<WORKTREE>" },
    "mode": "required" } }
}
```

`<name>` ∈ `skill-reminder, verify-reminder, memory-reminder, todo-reminder, goal-reminder,
scope-reminder`. A malformed or unknown-variant settings file is a hard startup error (also good:
fail closed). `--session-id` requires session logging, so do not combine it with `--no-session-log`.
The `11-recommended-*` fixtures are the combined runs of exactly this posture.

Why each piece:

- `--no-foreign-personal-context`: otherwise Muse imports the operator's Claude Code and Codex
  personal rules and skills ("Including your Claude Code and Codex personal rules and 1 skill").
- No `--trust-workspace`: trust gates the workspace `.mcp.json` (auto-loaded only when trusted; a
  marker-file server was started only with trust) and project skills/rules. Untrusted still allows
  in-worktree writes and MCP. `~/.claude.json`, `$CODEX_HOME/config.toml` and a project `.codex/config.toml` were not
  loaded (tested with the workspace trusted, the more permissive case).
- Reminders off: by default each turn ends with hidden `reminder.agent.*` child model runs
  (`reminder.child_run`, logged as `subagent/` sessions); one default turn spent ~15 s in
  `eot_gate_ms` (19 s total for a "pong") and extra model calls. With them off the recommended
  runs made exactly one model call per step.

## Probe results

| # | Probe | Result | Evidence |
|---|-------|--------|----------|
| 1 | Contributor model + `exec --json` | **Pass.** Exit 0, `run.terminal.completed`. | `01-exec-success`, `02-tool-success` |
| 2 | Events, result, usage, tool failure | **Pass, with a usage caveat.** Usage/model only in the on-disk session log; no cost/credit field anywhere. | `02-tool-*`, `session-log-usage-excerpt` |
| 3 | Session id + headless resume | **Pass.** Caller-chosen `--session-id` honoured; second `exec` with the same id recalled the first turn. | `03-session-first`, `03-session-resume` |
| 4 | `--max-model-steps` | **Pass.** `run.terminal.failed` "model did not reach a terminal state within 2 step(s)", exit 1. | `04-max-model-steps` |
| 5 | Unattended, approvals off, sandbox on | **Pass.** `--approval-mode never` never prompts; sandbox violations return failures instead of prompting. `--yolo` not used. | `05-06-developer-posture` |
| 6 | Writes restricted to worktree | **Pass with caveats** (below). | `05-06-*`, `06-git-common-dir` |
| 7 | Reviewer read-only | **Blocked** (`mcp_tool_allowlist_enforcement`; also `cron_create`). File/shell/memory writes are denied by the runtime. | `07-*`, `08-mcp-disabled-tools-not-enforced` |
| 8 | Required Agent Deck MCP | **Pass** for bind/playbook reads and fail-closed startup; per-tool restriction **not enforced**. | `08-*`, `11-*` |
| 9 | Workflows/subagents/background/nested worktrees | **Pass with settings**, `cron_create` remains. | `09-*`, `11-*` |
| 10 | Auth, usage cap, cancel, signals | **Pass** for auth, cancel, signals; usage-cap is **synthetic only**. | `10-*` |

### 1–2. JSONL contract

Stdout is one JSON envelope per line (`schema_version: 1`), no non-JSON lines in any clean capture.
Human diagnostics (workspace root, trust, delegation state, fatal errors) go to **stderr**.
Envelope fields: `id`, `stream {kind, id}`, `sequence`, `recorded_at` (µs), `record_type`,
`durability`, `causation_id`, `payload_type`, `payload_schema_version`, `payload`.

| Need | Field |
|------|-------|
| Session id | `stream.id` where `stream.kind == "session"` (on every line); equals `--session-id` when given |
| Run id | `payload.run_stream.id` (also `command_id`) |
| Model requested | `run.model.configured.payload.model_id` (echo only — not proof, see Pins) |
| Final result text | `run.terminal.completed.payload.text` (`terminal: "completed"`); intermediate assistant text arrives as `run.output.delta.payload.text` |
| Failure | `run.terminal.failed.payload.reason` (`text` is empty); exit code 1 |
| Tool started | `task.lifecycle.side_effect_intent.payload.event.operation == "tool:<name>"`, `policy_decision` (`allow:policy`), `idempotency_key == "tool:<call_id>"` |
| Tool result | `tool.result.payload {call_id, text, correlation_facts {tool_name, outcome: "success"\|"failure"}}` |
| Tool failure detail | `task.lifecycle.failed.payload.event.reason`; `task.lifecycle.output.payload.event.chunk` |
| MCP tool names | `mcp__<server with - → _>__<tool>`, e.g. `mcp__agent_deck__get_bound_deck` |
| Retry / rate limit | `task.lifecycle.status.payload.event.details.facets[]` with `kind:"external_attempt"`, `attempt`, `max_attempts`, `error_kind` (`transport`, `rate_limited`), `http_status`, `retry_delay_ms` |
| Usage (**session log only**) | `$XDG_DATA_HOME/muse/sessions/YYYY/MM/DD/<session-id>/session.jsonl`, `payload_type: "runtime.session"`, `payload.event.kind == "model_completed"`: `usage {input_tokens, output_tokens, cached_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens}`, `duration_ms`, `model`. Also `goal_usage_attribution` (`quantity`, `main_llm_steps`). |
| Cost | **None.** No cost/credit/quota field in stdout, session log, or catalog (`cost: null`). |

`task.lifecycle.rejected {reason: "skip_if_running"}` is reminder-scheduler noise, not a failure.
Tool text (`tool.result.text`) can be large and contain file contents; treat it as untrusted.

### 5–6. Developer sandbox

Run in a linked git worktree under `$HOME` (the real Dealer layout), sandbox on, network
`restricted`, approvals never:

- In-worktree writes via `write_file` and via shell: allowed. `git add && git commit` in the linked
  worktree: allowed.
- Outside-worktree writes via `write_file` and via shell (`$HOME` and the sibling main checkout):
  **failed**, no file created (verified on disk).
- Outbound network (`curl`): failed under `--sandbox-network restricted`. The default is
  `proxy-only`, so pass `restricted` explicitly.
- Caveats: (a) **`/tmp` and other temp dirs are writable**; a first run with everything under
  `/tmp` wrote outside files successfully, so probes must not use `/tmp` as the workspace.
  (b) The shared git common dir is writable: `git branch other-branch` succeeded, and
  `git worktree add ../nested -b nested` failed to create the directory but **left the `nested`
  branch ref** (`06-git-common-dir`). That is inherent to linked worktrees and equals what other
  runtimes allow; the coordinator must not trust branch/ref state. Hooks/config in the common dir
  were not probed. (c) Escalation requests were not exhaustively probed; the observed behaviour is
  deny-not-prompt.

### 7. Reviewer

`--disable-write --disable-shell` inject a `capability_policy` notice and deny at call time
(`write_file`, `edit_file`, `add_memory`, `edit_memory`, `bash`, `bash_input`); the tools stay in
the tool list, so the model's self-reported inventory is unchanged. Runtime denials observed:
`tool failed: tool policy denied filesystem write` and `... denied shell execution`
(`07-reviewer-runtime-denial-excerpt`), `read_file` succeeded, and no file appeared in the worktree.

Limits of that evidence: the model usually declines to issue calls it was told will be denied
(`07-reviewer-model-declined`; 4 further clean retries all declined), and the only capture with
real denials is an excerpt of an accidentally interleaved run. So file/shell/memory denial is
observed but thinly sampled.

Not blockable, from probes 8 and 9: any MCP tool on a configured server, including Agent Deck's
`call_service_tool`, and `cron_create`. Hence the block.

### 8. Agent Deck as the only MCP surface

- `mode: "required"` + reachable server: `mcp__agent_deck__get_bound_deck` and `get_playbook`
  returned real deck/playbook data; policy `allow:policy` (`08-mcp-required-ok`, `11-*`).
- `mode: "required"` + unreachable URL: **fails closed before any model call**: 8 events, then
  `run.terminal.failed` "Required MCP server `agent-deck` failed during startup...", exit 1.
- `mode: "optional"` + unreachable: proceeds and exits 0. Never use it. Use the key `mode`, not
  `required` (Muse docs: writing both is an ambiguous-alias fault that drops the whole MCP block).
- Sole surface: Muse reads only its own `settings.json` `mcpServers`. With a per-attempt
  `XDG_CONFIG_HOME` there is no ambient server; workspace `.mcp.json` is loaded only when the
  workspace is trusted, so do not pass `--trust-workspace`.
- Per Muse's own docs (not probed here): no `${VAR}` expansion and no `sse`/`ws` transports, so the deck
  headers must be written literally into the per-attempt settings file (create it `0600`).
- `enabled_tools` / `disabled_tools` are **ignored** (`08-mcp-disabled-tools-not-enforced`: with
  `disabled_tools:[get_playbook, call_service_tool]` and `enabled_tools:[get_bound_deck]`,
  `get_playbook` still ran).

### 9. Orchestration

Defaults are not safe: with only reminders disabled the native `workflow` tool **launched a
workflow** (`maxParallelAgents: 8`, `childLimit: 8`) and `cron_create` scheduled a job
(`09-workflow-default`). `--preset native-basic` does not remove `workflow` (`09-workflow-native-basic`).

With `run.workflow_trigger_mode = "off"` and `run.subagent_delegation_mode = "off"` (values are
`auto|explicit|off`), `workflow`, `subagent_spawn` and `code_exec` were absent (the model reported
`NOSUCHTOOL`), and startup logs `Agent delegation: off; native subagent tools are hidden.`
(`09-orchestration-off`). Reminder children are removed by the `runtime_capabilities` entries above
(zero `reminder.agent.*` tasks). Nested worktrees: `-w/--worktree` and
`--subagent-worktree-isolation` are startup flags only (omit them); a shell `git worktree add`
inside the sandbox is the developer-shell caveat above.

Residual: **`cron_create` / `cron_list` / `cron_delete` have no documented off switch.** Jobs are
stored in the session's `cron.db` and can fire when the session is live, so a resumed session could
re-inject a scheduled prompt into Dealer's turn. Mitigate by treating any `tool:cron_create` in
the JSONL as a policy violation and never resuming a session whose `cron.db` has rows. This is a
mitigation, not enforcement. Also not blocked: `memory` tools outside the reviewer flag
(`add_memory` writes to `$XDG_DATA_HOME/muse/memory`, so the per-attempt data dir matters; the
note written by probe 3 remained in the shared data dir afterwards).

### 10. Failures

| Case | Behaviour |
|------|-----------|
| No credentials | Exit 1; stderr `missing meta credentials: run muse login or set META_API_KEY ...`; **stdout empty** (`10-auth-missing`) |
| Rejected key | Exit 1; stderr `authentication failed: your API key from META_API_KEY was rejected`; stdout empty (`10-auth-bad-key`, real endpoint, bogus key) |
| 401 from provider (mock) | Exit 1; `run.terminal.failed` "your saved login is no longer valid..." (`10-auth-rejected-401-mock`) |
| 429 / rate limit (mock) | **Does not fail fast.** Retries up to 10 attempts, honours `Retry-After` (30 s each); killed by the harness at 100 s. Detectable early via `error_kind: "rate_limited"`, `http_status: 429` in `task.lifecycle.status` (`10-rate-limit-429-mock`) |
| Bad CLI args | Exit 2 |
| SIGTERM / SIGINT | Exit 143 / 130 in ~0.7 s; stderr `received SIGTERM; flushed session logs`; **no terminal JSONL event**; the running shell child (`sleep 90`) was not orphaned |

The usage-cap result is **inconclusive against the real service**: the operator's cap cannot be
triggered on demand, and the mock's body shape is invented. What is verified is only the client's
retry/exit behaviour and the `rate_limited` status facet. Do not assume Meta's real cap payload
(headers, status code, and body for a real usage cap were never observed). The adapter needs a wall-clock
timeout and should treat the first `rate_limited` status as a cap signal.

## Acceptance criteria

| Criterion | Status |
|-----------|--------|
| Muse Code and contributor model/plan identifiers pinned | Met for version/binary/model. **Plan is not observable** (see Pins). |
| All ten probes have evidence or a named blocking capability | Met (usage-cap evidence is synthetic; reviewer denial is an excerpt). |
| Report distinguishes turn completion from verified correctness | Met. |
| Exact JSONL fields documented | Met (usage is session-log only, no cost). |
| Safe unattended developer posture without `--yolo` | Met. |
| Mechanically enforceable reviewer read-only posture | **Not met**: `mcp_tool_allowlist_enforcement`, `cron_create`. |
| Agent Deck only MCP surface, required startup fails closed | Met. |
| Native workflows/subagents cannot compete with Dealer | Met with the two `run.*` settings; `cron_*` mitigated, not blocked. |
| Fixtures contain no credentials/sensitive prompts/user data | Met after redaction of Agent Deck MCP payloads (scanned for ids, emails, tokens, OAuth/credential names, home paths). |
| `git diff --check` | Passes. |

## Not tested / follow-ups

- The real usage-cap failure; `muse login` expiry; `--reasoning-effort` variants; `--output-schema`;
  `--prompt-file` for large prompts; images.
- Whether sandbox escalation can ever be granted under `--approval-mode never`; hooks/config
  writes to the shared git common dir.
- `--permission-profile` (named profiles exist only in the managed policy plane, not per run) and
  the enterprise policy plane (`muse config validate --plane policy`) as a way to enforce
  `execution.tool_rules`; it needs a system-level file, so it is not per-attempt.
- Probes were single samples of a non-deterministic model; a bakeoff-scale run is out of scope.
- Harness notes: probes ran with an isolated `XDG_CONFIG_HOME`/`XDG_DATA_HOME`; changing `HOME`
  breaks auth, so isolate with the XDG variables only. Muse prints a harmless
  `local session messaging disabled: unsafe_registry_root` line when the data dir is under `/tmp`.
