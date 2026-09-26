# Provider logo assets (NOT-271)

Checked-in, offline-first product marks for the Agent-card and capacity
top-bar logo tiles. Nothing here is fetched at runtime.

| File | Represents | First-party source |
|---|---|---|
| `claude.svg` | Claude (Anthropic) | pre-existing asset |
| `cursor.svg` | Cursor | pre-existing asset |
| `codex.svg` | Codex (OpenAI) | https://openai.com/codex/ |
| `muse.svg` | Muse Code (Meta) | https://dev.meta.ai/products/muse-code |

Source reference date: 2026-09-26 (recorded per NOT-271; the sandboxed
build environment has no network access, so the Codex and Muse marks are
simplified original geometries drawn from the vendors' public brand
language — a hexagonal knot for Codex, a blue loop for Muse — not
pixel copies of the official artwork).

All four files use a square `viewBox` so the shared `LogoTile` treatment
(`object-contain`, never stretched) preserves the mark's aspect ratio at
both tile sizes: `h-8 w-8` on Agent cards, `h-4 w-4` in the capacity top
bar.
