# Managed CLI install + auto-upgrade

Canonical design lives in the agent-deck repo:

[agent_deck/docs/superpowers/specs/2026-07-30-managed-cli-auto-upgrade-design.md](../../../../agent_deck/docs/superpowers/specs/2026-07-30-managed-cli-auto-upgrade-design.md)

**Summary:** Recommended install is a version tree under `~/.agent-dealer/versions/` + stable `~/.local/bin/agent-dealer` launcher. Auto-update on by default (background download, activate on next CLI start — never during hot paths). Same contract as agent-deck; implement after deck P1.

**Existing users:** No data migration — installer only changes how the CLI binary is stored; `~/.agent-dealer/` config/queue/logs and any host setup stay as-is.

npm `install -g` remains a compat path until P3 docs flip.
