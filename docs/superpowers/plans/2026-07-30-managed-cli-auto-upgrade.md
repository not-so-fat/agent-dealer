# Managed CLI auto-upgrade — agent-dealer (P2)

**Status:** Implemented (mirrors agent-deck managed contract)

Canonical design: [agent_deck …/2026-07-30-managed-cli-auto-upgrade-design.md](../../../../agent_deck/docs/superpowers/specs/2026-07-30-managed-cli-auto-upgrade-design.md)

Shipped in this repo:
- `packages/cli/src/managed/*` — versions / current / launcher / updater
- `agent-dealer install` / managed `upgrade` / doctor install-kind
- `scripts/install.sh` + README / PUBLISHING friend path
- Auto-update on by default for managed; `AGENT_DEALER_DISABLE_AUTOUPDATER=1` to opt out
- No data migration — `~/.agent-dealer` config/queue/logs unchanged
