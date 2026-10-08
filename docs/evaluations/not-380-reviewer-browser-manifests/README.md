# NOT-380 probe manifests

Committed evidence for [docs/evaluations/not-380-reviewer-browser-sandbox.md](../not-380-reviewer-browser-sandbox.md).

## What is here

| File | Produced by | Status |
|------|-------------|--------|
| `muse_code.direct.probe.json` | live harness run, `muse_code` control (spawns nothing) | `blocked` — known unsupported control |
| `*.dry-run.json` (10 files) | `--dry-run` launch records, all runtimes × contracts | exact bin/argv/preflight, no session spent |

All files are sanitized (`$HOME` → `~`). The probe manifest carries a
`verdictBinding.manifestSha256` over its own canonical bytes (excluding the hash
field itself); dry-run records carry no hash.

## What the operator adds

Live runs (see the evaluation doc for the exact commands) write sanitized
`*.probe.json` manifests here:

- `claude_code.direct.probe.json` + `codex_local.direct.probe.json` (required)
- `claude_code.playwright-mcp.probe.json` + `codex_local.playwright-mcp.probe.json`
- `claude_code.coordinator-preview.probe.json` + `codex_local.coordinator-preview.probe.json`
- one `--cancel-after-ms` run per runtime (cancellation control)
- one `--timeout-ms 10000` run per runtime (forced-timeout control)
- reviewer screenshots referenced by the manifests (PNG files beside them)

Every manifest records the tested HEAD (`headSha`), runtime/binary versions,
loopback + browser outcome, per-viewport interaction state, per-control
action/expected/observed/exit-status, artifact paths + sha256, and cleanup
facts. A manifest whose `status` is not `pass`/`blocked` with a matching
`headSha` is not evidence for the recommended contract.
