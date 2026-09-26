# Provider logo assets (NOT-271)

Checked-in, offline-first product marks for the Agent-card and capacity
top-bar logo tiles. Nothing here is fetched at runtime.

| File | Represents | Provenance |
|---|---|---|
| `claude.svg` | Claude (Anthropic) | pre-existing asset |
| `cursor.svg` | Cursor | pre-existing asset |
| `codex.png` | Codex (OpenAI) | verbatim first-party app icon, downscaled (see below) |
| `muse.svg` | Muse Code (Meta) | interim redraw referencing the first-party mark (see below) |

## Codex

`codex.png` is the verbatim first-party Codex product icon: the
`icon-codex-dark-color.png` shipped inside the Codex macOS app bundle
(bundle identifier `com.openai.codex`, version 26.924.20706 build 11431),
retrieved 2026-09-26 (source file 1024x1024 RGBA,
MD5 `d59bbf589905db550bd212b2b073bf55`). It is checked in downscaled to
128x128 lossless PNG via `sips` (14,676 bytes) — 8x the 16px top-bar tile
and 4x the 32px Agent-card tile. Square, so the shared `LogoTile`
treatment (`object-contain`, never stretched) preserves the mark's aspect
ratio at both sizes. The dark variant matches the dark header/cards; the
blue terminal-mark cloud stays identifiable down to 16px.

## Muse

The verbatim Muse artwork could not be retrieved in this environment (no
network access; no Meta app bundle on disk), so `muse.svg` is an interim
original redraw of the Muse loop mark — a continuous blue-gradient loop in
Meta blue (`#0082FB` to `#0064E0`) — referencing the first-party source
[Meta Muse Code](https://dev.meta.ai/products/muse-code) (reference date
2026-09-26). Square `viewBox`, preserved by the same `LogoTile`
treatment. Replace these bytes with the verbatim first-party asset when
network access allows; never hotlink a remote logo at runtime.
