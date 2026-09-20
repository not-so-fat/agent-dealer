# NOT-177: Muse Code headless, contributor-tier, and orchestration contract

Go/no-go spike for a native Muse Code runtime adapter. Everything below was observed by running
the installed CLI (not Codex, never `--yolo`) against the operator's contributor-tier model.
Sanitized captures: `packages/server/src/runners/fixtures/muse-code/` (index: `manifest.json`; the scripts that ran
probes 8-unreachable, 9-cron and 10 are in `harness/`).
No production Runtime/profile/spawn code was changed.

## Conclusion

**`blocked_by_named_capability`**

Four named capabilities block integration. None was found to be enforceable, and none is assumed:

| Capability | Gap | Probe |
|------------|-----|-------|
| `mcp_tool_allowlist_enforcement` | Muse Code 1.3.0-R3401.1 stores but does not enforce per-tool MCP `enabled_tools` / `disabled_tools` (its own migration guide says so; an excluded tool still executed). Agent Deck has no server-side read-only mode either (deck headers select a deck and workspace only). A reviewer with Agent Deck configured, which Dealer requires, can always reach `call_service_tool`, the outbound-mutation path. | 7, 8 |
| `cron_tool_disable` | `cron_create` / `cron_list` / `cron_delete` stay available with workflows and subagents off, and no per-run switch removes them (five attempts, below). A created job persists in the session's `cron.db` as an active recurring row, and in the recorded run it **fired inside the same `muse exec` process and started a second agent run that executed a shell command** (`09-cron-disable-attempt`). Agent Dealer is therefore not assured to be the sole orchestrator, and detecting the event afterwards is not prevention. | 9 |
| `plan_identifier_observability` | The operator's contributor plan cannot be observed. Only the `-contributor` model suffix is a tier signal, and there is no independent plan/tier evidence in the CLI, JSONL, session log, catalog, or `muse config status`. | pins |
| `usage_cap_observability` | A real usage-cap / quota failure could not be triggered or observed on the operator's account. Only a synthetic 429 mock exists, and Meta's real payload, status, and headers are unknown. | 10 |

Everything else worked, so this is a set of narrow, named blocks and not `do_not_integrate`:
probes 1–6 and 8 pass, and probe 10 passes for authentication failure, cancellation (SIGTERM, SIGINT, process-group
SIGTERM, resume after cancel), and signal exit codes; the real usage-cap half of probe 10 is blocked.
Unblock paths (none probed):

1. Muse enforces `enabled_tools`/`disabled_tools` for `mcpServers` entries, or offers a per-run switch for `cron_*` (then re-run probes 8 and 9).
2. Dealer ships a filtering stdio MCP proxy as the only configured server (new production surface; needs its own ticket and threat model).
3. Reviewer runs with no MCP server, with playbook/deck text fetched by Dealer and put in the prompt. This relaxes acceptance criterion 8 for the reviewer and still leaves `cron_create`.
4. The operator supplies plan-identifier evidence (e.g. an account/plan screenshot or billing record, sanitized) and a real usage-cap capture; both need the operator's account.

## Pins

| Item | Value |
|------|-------|
| Muse Code | `1.3.0 (1.3.0-R3401.1)`, channel `muse-stable`, release `state: public` |
| Binary | `~/.local/bin/muse-bin-1.3.0-R3401.1`, sha256 `20c5eb32f6aea741adac032c14be2f1897432caaf35144c33279a4d2b0bd8840` |
| Model | `muse-spark-1.3-contributor` (catalog: provider `meta`, profile `tbh`, `is_default: true`, released 2026-09-02, context 1,007,997, output 128,000; description "Your content, including inter-session messages, may be used for product improvement.") |
| Reasoning effort | default `high` (catalog tiers: minimal, low, medium, high, xhigh, max; CLI also accepts `none`, `ultra`). Not varied. |
| Auth | `muse login` (Meta account, stored in `$XDG_CONFIG_HOME/muse/auth.json`; contents never read). `META_API_KEY` in the environment takes priority. |
| Plan | **Not pinned: this pin criterion is unmet, blocked by `plan_identifier_observability`.** No plan/tier field appears in the JSONL, the session log, the model catalog (`cost: null`), or `muse config status`. The `-contributor` model id is the only tier signal, and it is a model identifier, not evidence of the operator's plan. |

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
| 7 | Reviewer read-only | **Blocked** (`mcp_tool_allowlist_enforcement`; also `cron_tool_disable`). File/shell/memory writes are denied by the runtime. | `07-*`, `08-mcp-disabled-tools-not-enforced` |
| 8 | Required Agent Deck MCP | **Pass** for bind/playbook reads and fail-closed startup; per-tool restriction **not enforced**. | `08-*`, `11-*` |
| 9 | Workflows/subagents/background/nested worktrees | **Blocked** (`cron_tool_disable`). Workflows, subagents, and reminder children are switched off by settings; `cron_create` cannot be, and its job persists. | `09-*`, `11-*` |
| 10 | Auth, usage cap, cancel, signals | **Partial.** Auth failure (`10-auth-*`), cancellation and signal exits (`10-sig*`, `10-cancel-resume-after-sigterm`) **pass**. Real usage-cap is **blocked** (`usage_cap_observability`); only a synthetic 429 mock exists (`10-*-mock*`). | `10-*` |

### 1–2. JSONL contract

Stdout is one JSON envelope per line (`schema_version: 1`), no non-JSON lines in any clean capture.
Human diagnostics (workspace root, trust, delegation state, fatal errors) go to **stderr**.
Envelope fields: `id`, `stream {kind, id}`, `sequence`, `recorded_at` (µs), `record_type`,
`durability`, `causation_id`, `payload_type`, `payload_schema_version`, `payload`.

| Need | Field |
|------|-------|
| Session id | `stream.id` where `stream.kind == "session"` (on every line); equals `--session-id` when given |
| Run id | `payload.run_stream.id` (also `command_id`). A cron-fired run inside the same process has its own run id (`09-cron-disable-attempt`). |
| Model requested | `run.model.configured.payload.model_id` (echo only — not proof, see Pins) |
| Final result text | `run.terminal.completed.payload.text` (`terminal: "completed"`); intermediate assistant text arrives as `run.output.delta.payload.text` |
| Failure | `run.terminal.failed.payload.reason` (`text` is empty); exit code 1 |
| Tool started | `task.lifecycle.side_effect_intent.payload.event.operation == "tool:<name>"`, `policy_decision` (`allow:policy`), `idempotency_key == "tool:<call_id>"`. Not every tool emits one: policy-denied calls and the read-only `work_status` returned a `tool.result` with no intent, so `tool.result` is the authoritative per-call record. |
| Tool result | `tool.result.payload {call_id, text, correlation_facts {tool_name, outcome: "success"\|"failure"}}` |
| Tool failure detail | `task.lifecycle.failed.payload.event.reason` (committed); `task.lifecycle.output.payload.event.chunk` (seen in the raw captures, dropped by compaction) |
| MCP tool names | `mcp__<server with - → _>__<tool>`, e.g. `mcp__agent_deck__get_bound_deck` |
| Retry / rate limit | `task.lifecycle.status.payload.event.details.facets[]` with `kind:"external_attempt"`, `attempt`, `max_attempts`, `error_kind` (`transport`, `rate_limited`), `http_status`, `retry_delay_ms` |
| Usage (**session log only**) | `$XDG_DATA_HOME/muse/sessions/YYYY/MM/DD/<session-id>/session.jsonl`, `payload_type: "runtime.session"`, `payload.event.kind == "model_completed"`: `usage {input_tokens, output_tokens, cached_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens}`, `duration_ms`, `model` (committed excerpt). `goal_usage_attribution` (`quantity`, `main_llm_steps`) also exists in the raw session log; not committed. |
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
`call_service_tool`, and `cron_create`. Hence the block (`mcp_tool_allowlist_enforcement`,
`cron_tool_disable`).

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

**Blocking gap `cron_tool_disable`.** `cron_create` / `cron_list` / `cron_delete` stay callable in the
recommended posture, and there is no per-run switch that removes them. Evidence (all rerun with the committed
`harness/probe8-9.sh` in round 3):

- `09-orchestration-off` and `09-cron-disable-attempt`: with `run.workflow_trigger_mode = "off"` and
  `run.subagent_delegation_mode = "off"`, `cron_create` returns `outcome: "success"`.
- **The job fired inside the Dealer-owned process.** `09-cron-disable-attempt` contains two runs (two
  `run_stream` ids) from one `muse exec`: the first ends `run.terminal.completed` with the `cron_create` result,
  and the second, which the model was never prompted for, runs `tool:bash` `echo hi` (the job's prompt) and ends
  `completed` with `hi`. `09-cron-persisted-job.json` shows the row afterwards: **active, recurring
  (`* * * * *`), `fire_when_active_run: 1`, `fire_count: 1`**, 7-day TTL, `permanent: 0`. It outlives the process, so a
  later `--session-id` resume can have a prompt injected into a Dealer-owned turn too. (The round-2 capture of the
  same probe recorded `fire_count: 0`; from these two runs, firing appears to require the process to outlive the next
  minute boundary. That is an inference, not a separate test.)
- Five attempts to disable it (`manifest.json` → `cron_disable_attempts`, fixtures `09-cron-attempt-*`; the model
  sometimes retried, and every attempt that reached a model call ended with a successful `cron_create`):
  1. `execution.tool_rules` in user `settings.json`: ignored as an unknown member (policy-plane field). `cron_create` succeeded.
  2. `permissions.deny` list: "Named permission profiles are unavailable: missing field `schema_version`". `cron_create` succeeded.
  3. `permissions.schema_version` + `tool_rules`: "unknown user permissions field `tool_rules`". `cron_create` succeeded.
  4. A named profile with `tool_rules` and `--permission-profile noc`: exit 2, "cannot be used with `--sandbox-network`" (4a, full
     posture) and, with that flag removed, "cannot be used with `--approval-mode`" (4b). A named profile is mutually
     exclusive with the flags the unattended posture needs.
  5. `runtime_capabilities["tool:cron_create"] = {enabled: false}` (`09-cron-disable-attempt`): accepted silently, `cron_create` succeeded.
  The enterprise policy plane (`muse config validate --plane policy`) needs a system-level file and is not per-attempt.

Detecting `tool:cron_create` in the JSONL and refusing to resume would only react after the side effect, and the job
can already fire in the running process, so this is a mitigation, not enforcement, and does not satisfy the criterion.
Also not blocked: `memory` tools outside the reviewer flag (`add_memory` writes to `$XDG_DATA_HOME/muse/memory`, so the
per-attempt data dir matters; the note written by probe 3 remained in the shared data dir afterwards).

### 10. Failures, cancellation, signals

Every case ran through `harness/probe10.sh <case>` (see the README). The manifest `commands` field is the script's
own log of what it executed: `set -m`, the background launch with its redirections, the readiness loop, the
signal as delivered (`kill -TERM -- <pid>`), `wait <pid>; echo $? > ...rc`, the child-process checks. Mocks are started
with `python3 harness/mock-provider.py <port> <status> [retry-after] &`, and the exit code is whatever `wait` returned.

| Case | Behaviour |
|------|-----------|
| No credentials | Exit 1; stderr `missing meta credentials: run muse login or set META_API_KEY ...`; **stdout empty** (`10-auth-missing`). |
| Rejected key | Exit 1; stderr `failed to fetch model catalog: authentication failed: your API key from META_API_KEY was rejected`; stdout empty (`10-auth-bad-key`: real endpoint, bogus key via `--api-key-stdin`). With a fresh per-attempt data dir the first request is the model-catalog fetch, so auth failure surfaces at startup with no JSONL. |
| 401 from provider, warm catalog (mock) | Exit 1 in ~2 s; `run.terminal.failed` "your saved login is no longer valid..." after two `task.lifecycle.failed` events (`10-auth-rejected-401-mock`; the catalog was cached by a real 1-step call first). |
| 401, cold catalog (mock) | Exit 1, stdout empty, stderr `failed to fetch model catalog: authentication failed: your saved login is no longer valid...` (`10-auth-rejected-401-mock-cold`). |
| 429 / rate limit, warm catalog (mock, `Retry-After: 30`) | **Does not fail fast.** The client keeps retrying and `task.lifecycle.status` carries `error_kind: "rate_limited"`, `http_status: 429`; the run only ended because the harness watchdog sent SIGTERM at 100 s (exit 143, `watchdog_fired=yes`) (`10-rate-limit-429-mock`). |
| 429, cold catalog (mock) | Exit 1 immediately, stdout empty, stderr `failed to fetch model catalog: API error 429: ...` (`10-rate-limit-429-mock-cold`). |
| Bad CLI args | Exit 2 (`--permission-profile` with `--sandbox-network` / `--approval-mode`; `09-cron-attempt-4a/4b`). |
| **Cancellation:** SIGTERM to the muse pid | Exit 143 within ~1 s; stderr `received SIGTERM; flushed session logs`; **no terminal JSONL event**; the running shell child (`sleep 9137`) was not orphaned (`pgrep` count 2 before the signal, 0 after) (`10-sigterm`). |
| **Cancellation:** SIGTERM to the process group (`kill -TERM -- -<pid>`) | Exit 143, no orphan (2 before, 0 after) (`10-sigterm-process-group`). |
| Cancellation: SIGINT to the muse pid | Exit 130, `received SIGINT; flushed session logs`, no terminal event, no orphan (`10-sigint`). |
| Cancellation: SIGKILL to the muse pid only | Exit 137; the shell child **is orphaned** (2 before, 1 after) (`10-sigkill-orphan`). Never cancel with a lone KILL. |
| Resume after cancellation | The SIGTERM-cancelled session id resumed headlessly with the same XDG dirs: `run.terminal.completed`, exit 0 (`10-cancel-resume-after-sigterm`). |
| Wall-clock timeout | Same mechanism as cancellation: a watchdog `kill -TERM <pid>` (`10-rate-limit-429-mock` shows it firing). `muse exec` has no timeout flag of its own. |

"Cancellation" here is the coordinator terminating a live run by signal, since `muse exec` has no other cancel channel.
Because cancel produces no terminal event, the adapter must classify a signal exit code (130/143) plus a missing
terminal event as `cancelled`, not `failed`. The recommended posture uses a fresh per-attempt data dir, so auth and
catalog-level rate-limit failures are startup errors on stderr with an empty stdout, while inference-level failures
(warm catalog) arrive as JSONL; the adapter must handle both.

**Blocking gap `usage_cap_observability`.** The operator's usage cap cannot be triggered on demand, and the mocks'
bodies are invented, so what was verified is only the client's retry/exit behaviour and the `rate_limited` status
facet. The real usage-cap status, headers, and body were never observed and are not assumed. The adapter needs a
wall-clock timeout and could treat the first `rate_limited` status as a cap signal, but that is a design guess until
a real capture exists. Probe 10 is therefore **partial**, not passed.

## Acceptance criteria

Probe outcomes: **pass** 1, 2, 3, 4, 5, 6 (with caveats), 8 (bind/playbook reads and fail-closed startup); **partial** 10
(auth failure, cancellation and signals pass; the real usage cap is not observed); **blocked** 7 and 9. The
"all ten probes" criterion below is met only in the sense the ticket words it (saved evidence *or a named blocking
capability*); it does not mean ten passes.

| Criterion | Status |
|-----------|--------|
| Muse Code and contributor model/plan identifiers pinned | **Not met.** Version, binary sha256, and model id are pinned. The plan identifier is not observable (`plan_identifier_observability`). |
| All ten probes have saved evidence or a named blocking capability | Met as worded: probes 1–6, 8 have passing evidence; 7 (`mcp_tool_allowlist_enforcement`, `cron_tool_disable`), 9 (`cron_tool_disable`), and the usage-cap half of 10 (`usage_cap_observability`) are named blocks; probe 10 auth failure, cancellation and signals have passing evidence with exact recorded commands. |
| Report distinguishes turn completion from verified correctness | Met. |
| Exact JSONL fields documented | Met (usage is session-log only, no cost). |
| Safe unattended developer posture without `--yolo` | Met for approvals/sandbox/writes; the developer also has `cron_create`, which fired a second agent run (`cron_tool_disable`). |
| Mechanically enforceable reviewer read-only posture | **Not met**: `mcp_tool_allowlist_enforcement`, `cron_tool_disable`. |
| Agent Deck only MCP surface, required startup fails closed | Met. |
| Native workflows/subagents cannot compete with Dealer | **Not met**: workflows and subagents are switched off, but `cron_*` cannot be (`cron_tool_disable`), and the job fired in the recorded run. |
| Fixtures contain no credentials/sensitive prompts/user data | Met, and now mechanically checked by `muse-code-fixtures.test.ts` (uuids, provider call ids, emails, token shapes, home/scratch paths, operator/deck identity, malformed placeholders). Agent Deck MCP payload bodies are redacted. |
| `git diff --check` | Passes. |

Evidence quality:

- `manifest.json` gives, per capture, the complete sanitized command(s), exact `settings.json` (by profile), exit code,
  stderr, and raw / committed / dropped-per-type event counts. Those counts are computed by
  `harness/build-fixtures.py` from the raw captures and re-verified against the committed files by
  `muse-code-fixtures.test.ts`, which also fails on elided commands (`...`), placeholder prompts, comment-only "actions",
  a missing `kill`/`wait`/`pgrep` in a signal case, a sanitizer that rewrote a field name (e.g. `call_id`), and a
  `tool.result` whose call id does not match its `tool:<call_id>` intent.
- Probes 8-unreachable, 9-cron and all of 10 were (re)run in round 3 by the committed scripts under `harness/`; their
  manifest `commands` are those scripts' own logs. Probes 1–7, 8-ok/disabled-tools, 9 (workflow) and 11 are round-1
  captures made by typing the command inline; the manifest records the exact argv and prompt but the raw dumps are
  not in the repo, so their counts can only be checked against the committed files, not re-derived.
- Two entries are flagged `exact: false` with a reason: the interleaved reviewer-denial excerpt (prompt not
  recoverable) and the session-log usage excerpt (a file read, not a command).
- The compaction drops most events (see the fixtures README); a reader who needs an event type that was dropped
  (e.g. `task.lifecycle.output`) has to rerun the probe.

## Not tested / follow-ups

- The real usage-cap failure (blocking); plan identifier evidence (blocking); whether a `cron_create` job fires in a *resumed* session (it fired in a live one); `muse login` expiry; `--reasoning-effort` variants; `--output-schema`;
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
