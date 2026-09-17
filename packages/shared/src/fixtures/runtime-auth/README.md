# Runtime auth fixtures (NOT-133)

Verbatim CLI captures, not hand-written phrasings. NOT-133 happened because every test in
this area asserted against strings a test author invented (`"login required"`), so the
string the CLI actually prints (`"Authentication required"`) was never covered. Anything
`runtime-auth-health.ts` claims to match must be pinned by a capture in this directory.

Captured 2026-09-17 on macOS 15 (darwin 25.6.0) with:

| CLI            | version             |
| -------------- | ------------------- |
| `cursor-agent` | `2026.09.15-d2fe57e` |
| `codex`        | `codex-cli 0.154.0` |
| `claude`       | `2.1.270`           |

The logged-out captures were produced by pointing `HOME` at an empty throwaway directory —
never by logging the operator out:

```
PROBE=$(mktemp -d); mkdir -p "$PROBE/work"; cd "$PROBE/work"
env -i PATH="$PATH" HOME="$PROBE" <cli> <args> </dev/null > <fixture> 2>&1
```

| File | Command | Exit |
| ---- | ------- | ---- |
| `cursor-agent-print-logged-out.txt` | `cursor-agent -p "hello"` | 1 |
| `cursor-agent-print-invalid-api-key.txt` | `CURSOR_API_KEY=key_invalid_000 cursor-agent -p "hello"` | 1 |
| `cursor-agent-status-logged-out.txt` | `cursor-agent status` | 0 |
| `cursor-agent-status-logged-in.txt` | `cursor-agent status` (real HOME) | 0 |
| `codex-exec-logged-out.txt` | `codex exec --skip-git-repo-check "hello"` | 1 |
| `codex-login-status-logged-out.txt` | `codex login status` | 1 |
| `codex-login-status-logged-in.txt` | `codex login status` (real HOME) | 0 |
| `claude-print-logged-out.txt` | `claude -p "hello"` | 1 |
| `claude-print-invalid-api-key.txt` | `ANTHROPIC_API_KEY=sk-ant-invalid-000 claude -p "hello"` | 1 |
| `claude-auth-status-logged-out.txt` | `claude auth status` | 0 |
| `claude-auth-status-logged-in.txt` | `claude auth status` (real HOME) | 0 |

Notes:

- `cursor-agent status` prints **`Not logged in`** and exits **0** when logged out — that is
  why the NOT-133 admission gate was not the half that broke. The `-p` run is the one that
  says `Authentication required`.
- `cursor-agent status` and `codex login status` print the **same bytes** (`Not logged in`)
  when logged out, and `claude -p` starts its line the same way. That is why a log with no
  recorded runtime is only attributed to a CLI when the text names one (`CURSOR_API_KEY`,
  `api.openai.com`, `/login`); otherwise it is classified as an auth failure with a
  remediation covering all three, rather than guessed at.
- Captures keep their ANSI escapes (`cursor-agent` colourises `✓` and its warnings); the
  classifier must cope with them rather than assume stripped output.
- Two captures are redacted, and *only* for identity: the account e-mail in
  `cursor-agent-status-logged-in.txt` (→ `operator@example.com`) and the home path in
  `claude-auth-status-logged-in.txt` (→ `/Users/operator`). Every byte a pattern matches on
  is untouched.
