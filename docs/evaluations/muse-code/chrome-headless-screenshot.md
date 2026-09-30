# NOT-303 Phase 1: headless Chrome under the Muse developer sandbox

Spike findings. All probes below ran **inside a real Dealer-spawned Muse developer
session** (this session, `eb26e41d-9a9f-4c01-996c-78043220d0d1-developer`), with the
Muse sandbox on and `--sandbox-network restricted` — the same posture
`packages/server/src/runners/muse-code-args.ts` launches developers with. No product
code was changed for this phase.

Pins:

| Item | Value |
|------|-------|
| Chrome | `Google Chrome 154.0.8037.92` (`Google Chrome.app`, `com.google.Chrome`) |
| `Google Chrome --version` in-session | exit 0 (binary exists, is executable) |
| Host | macOS 26.6.2, Mac16,12 |
| In-session network | restricted (DNS blocked — `curl https://example.com` → `Could not resolve host`) |

## Result: `Google Chrome.app` cannot screenshot in-sandbox

| # | Command (in-session) | Exit | PNG / output |
|---|----------------------|------|--------------|
| 1 | `"…/Google Chrome" --headless=new --no-sandbox --disable-gpu --screenshot=/tmp/not303-shot.png "file:///tmp/not303-fixture.html"` (fixture: `<h1>hi</h1>`) | **134** (`Abort trap: 6`) | **no PNG written** |
| 2 | `"…/Google Chrome" --headless --no-sandbox --disable-gpu --dump-dom "about:blank"` | 0 | **empty output** |
| 3 | `"…/Google Chrome" --version` | 0 | `Google Chrome 154.0.8037.92` |

`--no-sandbox` only disables Chrome's own sandbox, so it cannot help: the crash is
at macOS process registration, before any renderer or Chrome-sandbox logic. The
network restriction is not the cause — `file://` and `about:blank` fail identically.

Crash signature (confirmed in `~/Library/Logs/DiagnosticReports/Google Chrome-*.ips`):
`SIGABRT`, stack `ChromeMain -> TransformProcessType -> _RegisterApplication ->
abort()` — Chrome failing to register with LaunchServices/WindowServer at startup.
A denied Mach/LaunchServices lookup under the Muse macOS sandbox is the working
cause (same stack on every launch).

Control (prior evidence, NOT-303 ticket): the same headless screenshot command run
**outside** the Muse sandbox succeeds and writes a PNG. So the binary is fine; the
sandbox is what kills it.

## Result: `chrome-headless-shell` is absent and cannot be fetched in-session

| Check (in-session) | Result |
|--------------------|--------|
| `command -v chrome-headless-shell` | not found (exit 1) |
| `~/.cache/ms-playwright`, `~/Library/Caches/ms-playwright` | absent (no Playwright browsers on host) |
| `curl https://example.com` (fetch viability) | `curl: (6) Could not resolve host` — sandbox network is `restricted` |

Obtaining the binary (`npx playwright install`, `npm` fetch, `brew`) needs network,
which the developer sandbox denies. So a headless shell **must be pre-installed on
the host** before any in-sandbox trial, and whether a non-AppKit build avoids the
`TransformProcessType` path is **still unverified** — it could not be tested from
this session.

## Conclusion → Phase 2 branch

**Nothing usable works in-sandbox today**, so Phase 2 takes the ticket's second
branch:

- Do NOT widen the sandbox (`--disable-sandbox` stays refused in
  `muse-config-core.ts`; the refusal test still passes — unchanged by this ticket).
- Declare visual QA **out of scope for the in-sandbox Muse Dev worker**: the worker
  prompt tells Muse developers not to burn steps probing `Google Chrome.app`
  (names the `RegisterApplication` abort) and to close with a `Visual QA:` line in
  the implementation conclusion; the reviewer prompt states a missing screenshot is
  never a pass (`visual QA not run` in `evidenceAssessment`).
- Ship a preflight classifier (`packages/server/src/adapters/muse-visual-qa.ts`)
  that resolves the screenshot path before the session starts: unusable by default
  (loud reason naming the abort + the missing binary), usable only when the
  operator pre-installs a headless shell and points `MUSE_HEADLESS_SHELL_BIN` at
  it. When that day comes, the remaining work is verifying one real in-sandbox
  screenshot off that binary — not a design change.
- A coordinator-side screenshot step on the worktree (outside the worker sandbox)
  is explicitly deferred as a follow-up, not built here.
