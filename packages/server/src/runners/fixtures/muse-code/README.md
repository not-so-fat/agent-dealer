# Muse Code headless-contract fixtures (NOT-177)

Sanitized captures of `muse exec --json` for **Muse Code 1.3.0 (1.3.0-R3401.1)**, model
`muse-spark-1.3-contributor`. The findings and the go/no-go conclusion live in
`docs/evaluations/muse-code/headless-contract.md`. `manifest.json` maps each capture to its probe,
its complete sanitized command(s), exact `settings.json`, exit code, stderr, and raw-vs-committed
line counts.

- `NN-*.jsonl` — stdout of one invocation, one JSON event per line, compacted (below). Prompts are
  synthetic probe prompts, never task content. Empty files are intentional (auth failures and
  startup errors emit nothing on stdout; see the manifest `stderr`).
- `session-log-usage-excerpt.jsonl` — usage/model-confirmation events from the **on-disk session
  log**, the only place usage exists (stdout carries none).
- `09-cron-persisted-job.json` — the `cron_jobs` row that `cron_create` left in the session's
  `cron.db`, written by the harness with `sqlite3 -json`.
- `settings/recommended.settings.template.json` — the isolated `$XDG_CONFIG_HOME/muse/settings.json`
  of the recommended postures (`<DECK_ID>` / `<WORKTREE>` are placeholders).
- `harness/` — everything needed to reproduce and rebuild:
  - `probe10.sh`, `probe8-9.sh`, `lib.sh`: the scripts that actually ran the auth / rate-limit /
    cancellation / signal probes, the unreachable-MCP probes, and the cron-disable attempts. Each case
    logs the exact shell line of every action it takes (background launch with redirections,
    readiness loops, watchdogs, signals, waits, exit-status capture, child-process checks); the
    manifest `commands` field is that log, sanitized. Run from this directory:
    `bash harness/probe10.sh sigterm`.
  - `mock-provider.py`: the synthetic provider for the 401/429 cases
    (`python3 harness/mock-provider.py <port> <status> [retry-after]`).
  - `specs.json`, `conventions.json`, `build-fixtures.py`: per-probe metadata (round-1 commands were
    typed inline before the harness existed; they are recorded verbatim here), and the sanitizer /
    compactor / manifest writer. `python3 harness/build-fixtures.py --round1 <raw dir> --harness <OUT_DIR>`
    regenerates every fixture and every count in `manifest.json` from raw captures.
- `../muse-code-fixtures.test.ts` re-checks the committed files: manifest counts vs. files, JSONL
  envelope and preserved field names (`call_id`, ...), tool intent/result id agreement, no credentials
  or machine paths or malformed placeholders, no elided commands.

## Sanitization and compaction

See `manifest.json` → `conventions` for placeholders (`<WORKSPACE>`, `<PROBE_HOME>`, `<id-N>`, ...),
what is redacted (Agent Deck MCP payload bodies become a size marker), and which events survive
compaction. Field names are never rewritten; only string values are. Raw captures are not committed
(they contain scheduler noise and machine paths); the manifest records exactly how many events were
dropped per type.

## Caveats

- `10-auth-rejected-401-mock` and `10-rate-limit-429-mock` come from `mock-provider.py` via
  `--base-url`; they show client behavior, not Meta's real error bodies. **No real usage-cap
  response was observed.**
- `07-reviewer-runtime-denial-excerpt` is an excerpt (intact `tool.result` lines only) of a capture
  in which two runs were accidentally interleaved; its manifest entry is `exact: false`.
- Round-1 captures (probes 1-9, 11) were produced by inline commands, not by `harness/`; the manifest
  says which. Their raw dumps live outside the repo, so the compaction counts are what the build
  script computed from them, not something a reader can re-derive from the repo alone.
- Captures are single samples of a non-deterministic model; treat runtime facts (event shapes,
  exit codes, denial strings), not model wording, as the evidence.
