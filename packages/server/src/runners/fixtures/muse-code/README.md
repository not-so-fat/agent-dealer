# Muse Code headless-contract fixtures (NOT-177)

Sanitized captures of `muse exec --json` for **Muse Code 1.3.0 (1.3.0-R3401.1)**, model
`muse-spark-1.3-contributor`. The findings and the go/no-go conclusion live in
`docs/evaluations/muse-code/headless-contract.md`; `manifest.json` maps each file to its probe,
sanitized command, config, exit code, stderr, and notes.

- `NN-*.jsonl` — raw stdout of one invocation, one JSON event per line. Prompts are synthetic
  probe prompts, never task content. Empty files are intentional (auth failures emit nothing on
  stdout; see the manifest `stderr`).
- `session-log-usage-excerpt.jsonl` — usage/model-confirmation events from the **on-disk session
  log**, which is the only place usage exists (stdout carries none).
- `settings/recommended.settings.template.json` — the isolated `$XDG_CONFIG_HOME/muse/settings.json`
  the recommended postures were verified with (`<DECK_ID>` / `<WORKTREE>` are placeholders).

## Sanitization

Ids (UUIDs, `call_*`, `resp_*`) become stable `<id-N>` / `<call-N>` / `<resp-N>` placeholders,
paths become `<WORKSPACE>` / `<HOME>`, `recorded_at` becomes `<ts>`, and any Agent Deck MCP tool
result body (real deck contents) is replaced by a size-only `<redacted MCP payload: N bytes>`.
The `unsafe_registry_root` stderr line (an artifact of the probe harness's data directory) is
dropped from `manifest.json`.

## Caveats

- `10-auth-rejected-401-mock` and `10-rate-limit-429-mock` come from a local mock server via
  `--base-url`; they show client behavior, not Meta's real error bodies.
- `07-reviewer-runtime-denial-excerpt` is an excerpt (intact `tool.result` lines only) of a capture
  in which two runs were accidentally interleaved.
- Captures are single samples of a non-deterministic model; treat runtime facts (event shapes,
  exit codes, denial strings), not model wording, as the evidence.
