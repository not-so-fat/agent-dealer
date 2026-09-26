# Provider logo assets (NOT-271)

Checked-in, offline-first product marks for the Agent-card and capacity
top-bar logo tiles. Nothing here is fetched at runtime.

| File | Represents | Provenance |
|---|---|---|
| `claude.svg` | Claude (Anthropic) | pre-existing asset |
| `cursor.svg` | Cursor | pre-existing asset |
| `codex.png` | Codex (OpenAI) | verbatim first-party app icon, downscaled (see below) |
| `muse.svg` | Muse Code (Meta) | interim redraw referencing the first-party mark, MD5 `e24645811462b986c9cd3110b70192b0` (see below) |

## Codex

`codex.png` is the verbatim first-party Codex product icon: the
`icon-codex-dark-color.png` shipped inside the Codex macOS app bundle
(bundle identifier `com.openai.codex`, version 26.924.20706 build 11431),
retrieved 2026-09-26 (source file 1024x1024 RGBA,
MD5 `d59bbf589905db550bd212b2b073bf55`). It is checked in downscaled to
108x108 lossless PNG (13,230 bytes,
MD5 `8a7c2e12cc53d4ac14274f2aafaf3b89`): the 128x128 `sips` downscale with
its 12px transparent macOS-icon padding per side cropped to a 2px fringe,
pixel content otherwise untouched. Still well above both render sizes (16px
top-bar tile, 32px Agent-card tile), so the crop makes the dark rounded
square fill the tile's 70%-image area instead of rendering ~9px inside the
16px tile. Square, so the shared `LogoTile` treatment (`object-contain`,
never stretched) preserves the mark's aspect ratio at both sizes. The dark
variant matches the dark header/cards; the blue terminal-mark cloud stays
identifiable down to 16px.

## Muse

The verbatim Muse artwork could not be retrieved in this environment, so
`muse.svg` is an interim original redraw of the Muse loop mark — a
continuous blue-gradient loop in Meta blue (`#0082FB` to `#0064E0`) —
referencing the first-party source
[Meta Muse Code](https://dev.meta.ai/products/muse-code) (reference date
2026-09-26). Retrieval re-attempted 2026-09-26 and still blocked: the
sandbox has no network egress (DNS fails for all hosts, so the product
page artwork cannot be fetched), no Meta app bundle is installed, and the
local Muse CLI (1.4.0-R4161.1, `~/.local/share/muse`) ships no image
assets — its 316MB binary contains no embedded PNGs. Retrieval
re-attempted again 2026-09-26 (round 4): still fully blocked — every host
probes `000` via curl (`registry.npmjs.org`, `example.com`, `dev.meta.ai`,
`openai.com`), no Meta/Muse app bundle is installed in `/Applications`,
and no renderer or fetcher exists that works offline. Square `viewBox`,
preserved by the same `LogoTile` treatment. To finish: with network
access, save the verbatim first-party mark from the URL above (checked in,
never hotlinked at runtime), record its source URL, retrieval date, and
checksum here, and delete this paragraph.
