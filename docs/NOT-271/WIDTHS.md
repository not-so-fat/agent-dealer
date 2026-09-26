# NOT-271 header evidence: logo-led blocks are narrower (AC7)

## Width analysis

The before/after change touches only the runtime-identity treatment: a
visible provider-name span (`text-xs`, 12px system-ui) becomes a fixed
`h-4 w-4` (16px) logo tile. Window stacks (`5H`/`1W`/`1M` + values),
gaps (`gap-1.5`), and exhausted-state padding are byte-identical in both
variants, so each block shrinks by exactly (name width − 16px).

Name widths measured from real system-font advances (stdlib TrueType
parse of `hmtx`/`cmap`; 12px):

| Block | SFNS (system-ui proxy) | Helvetica (cross-check) | Logo | Saved (SFNS) |
|---|---|---|---|---|
| Claude | 35.8px | 40.0px | 16px | ~20px |
| Codex | 33.0px | 36.7px | 16px | ~17px |
| Muse Code | 57.9px | 64.0px | 16px | ~42px |
| Cursor | 33.9px | 39.3px | 16px | ~18px |
| **Identity total** | **160.6px** | **180.0px** | **64px** | **~97px** |

Every provider name is wider than the 16px tile in both fonts, so all
four logo-led blocks together use ~97–116px less horizontal space than
the text-led blocks at the same viewport.

## Same-viewport fixtures

`capacity-header-before.html` and `capacity-header-after.html` render the
same two datasets (`ready-4`, `exhausted-and-na`) at a 360px viewport:

- AFTER markup is the verbatim `renderToStaticMarkup` output of the real
  `TopBarCapacityView` (same `summarizeCapacity()` data path as the tests),
  with logo `src`s rewritten to the checked-in assets.
- BEFORE markup is that same output with the NOT-271 block change inverted
  per block: the `h-4 w-4` logo tile back to the NOT-266
  `<span class="text-white/40">Name</span>` (`text-red-200/80` when
  exhausted) and the `role="group"`/`aria-label` removed — the exact
  NOT-266 treatment.
- Styling is the exact Tailwind geometry the component uses (flex gaps,
  12px type, tile sizes, exhausted border/padding), inlined so the files
  open standalone.

To capture the PR screenshots: open both files in a browser at 360px
width and screenshot the `ready-4` section (plus the `exhausted-and-na`
section to show the logo stays identifiable in exhausted/N/A states).
Each page self-measures on load: per-block `offsetWidth`s render into the
metrics table and `document.title`, and the section reports any
`scrollWidth − clientWidth` overflow (expected: 0 — blocks are
`inline-flex` + `whitespace-nowrap` with no absolute positioning or
negative margins, so a logo cannot overlap or clip its values by
construction).

## Pixel renders (attached — offline composite, not browser pixels)

`capacity-header-before.png` and `capacity-header-after.png` (in this
directory) render both cases at the same 360px content width, produced
2026-09-26 by `/tmp/render-capacity.py` with no browser and no network:

- Icons are pixel renders of the CHECKED-IN assets: Claude/Cursor via
  even-odd scanline fill of their SVG paths, Muse via disc-stamped
  gradient stroke of its SVG path, Codex via stdlib PNG decode of
  `codex.png` — each composited into the 16px `LogoTile` (rounded-lg,
  white 4%, 70% image) exactly as `AgentIcon.tsx` specifies.
- Text is real `ffmpeg drawtext` output with the system font
  (`Helvetica.ttc`) at the real 12px size; positions come from stdlib
  TrueType-advance layout using the exact fixture flex geometry (gaps
  12/6/4, 15px stack rows, exhausted border+padding, greedy flex-wrap).
- Known approximations (do not affect the width claim): CAPACITY
  letter-spacing omitted (present in both variants equally), `font-medium`
  rendered with the Regular face, section captions at 12px instead of
  13px, viewport border solid instead of dashed.

What the pixels show: every after block leads with a 16px logo and no
name text; `5H`/`1W`/`1M` values are all legible; the exhausted Codex
block keeps its red border/tint with a red `0%`; the N/A Muse block stays
dim; no logo overlaps or clips its values (blocks are sequential
non-overlapping boxes by construction — same guarantee as the fixture
CSS, which has no absolute positioning or negative margins).

Measured block widths from the same layout pass (Helvetica 12px):

| Block | Before (name-led) | After (logo-led) | Saved |
|---|---|---|---|
| Claude | 90.0px | 68.0px | 22.0px |
| Codex | 86.7px | 68.0px | 18.7px |
| Muse Code | 113.4px | 68.0px | 45.4px |
| Cursor | 86.7px | 66.7px | 20.0px |
| ready-4 block total | 376.8px | 270.7px | ~106px |
| Codex exhausted | 100.7px | 82.0px | 18.7px |
| Muse Code N/A | 109.4px | 64.0px | 45.4px |

Every after block is narrower than its before twin, and the after bar
fits three logo-led blocks plus the CAPACITY eyebrow on the first 360px
line where the before bar only fits two name-led blocks. A true browser
screenshot at 360px on a networked machine remains a welcome
corroboration (open both `.html` fixtures side by side), but the width
claim no longer depends on it: identical window stacks plus per-block
(name width − 16px) savings hold in both measured system fonts.

What IS verified here without pixels (`/tmp/verify-widths.py` logic,
re-run 2026-09-26, ALL PASS):

- AFTER: all 6 provider blocks (4 ready + Codex-exhausted + Muse-Code-N/A)
  carry exactly one `h-4 w-4` tile with a logo `<img>` and no visible
  provider-name text.
- BEFORE: all 6 blocks carry a name span and no logo tile or `<img>`.
- Window stacks are byte-identical before/after once the single identity
  node (plus NOT-271's `role`/`aria-label`) is normalized — only the
  identity treatment changed.
- No absolute positioning or negative margins anywhere in the fixture CSS;
  viewports use `overflow:hidden`, so a logo cannot overlap or clip its
  values by construction.
- No `file://` paths remain (preload links removed 2026-09-26; images
  resolve via paths relative to `docs/NOT-271/`).
- Independent font-metric re-measurement (stdlib TrueType parse,
  `/System/Library/Fonts/Helvetica.ttc` Unicode map, 12px): Claude 38.0px,
  Codex 34.7px, Muse Code 61.4px, Cursor 36.0px — every name wider than the
  16px tile, ~105px saved across the four blocks, corroborating the table
  above.
