# Provider logo assets (NOT-271)

Checked-in, offline-first product marks for the Agent-card and capacity
top-bar logo tiles. Nothing here is fetched at runtime.

| File | Represents | Provenance |
|---|---|---|
| `claude.svg` | Claude (Anthropic) | pre-existing asset |
| `cursor.svg` | Cursor | pre-existing asset |
| `codex.png` | Codex (OpenAI) | verbatim first-party app icon, downscaled (see below) |
| `muse.svg` | Muse Code (Meta) | exact Meta infinity mark extracted from Meta's first-party SVG (see below) |

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

Meta's first-party [Muse Code product page](https://dev.meta.ai/products/muse-code)
does not publish a distinct Muse Code icon: the product identity is a
text-only “Muse Code” heading beneath Meta branding. For the compact
provider tile, `muse.svg` therefore uses the official Meta infinity mark
that identifies Muse Code's vendor rather than inventing a Muse-specific
symbol.

The 13 infinity-mark paths and their gradients are copied exactly from
Meta's first-party
[`meta-logo-with-text.svg`](https://dev.meta.ai/logo/meta-logo-with-text.svg),
retrieved 2026-09-26. The downloaded source SHA-256 is
`7a0430c375fc8563eafa7636869b5b132e6da4461711a81d384bc0044a20d039`.
Only the trailing “Meta” wordmark paths were omitted and the `viewBox` was
tightened to the infinity-mark bounds; path geometry, fill colors, and
gradient coordinates are unchanged. The asset is checked in and never
fetched at runtime. Its checked-in SHA-256 is
`46648966515643b9d4a0d445b2a0d8e3aa9dc9063a2f4dc85115d8a5427ca033`.
