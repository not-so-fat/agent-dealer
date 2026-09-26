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

## Pixel screenshots (still open — needs a browser)

Pixel screenshots could not be captured in this sandbox, re-confirmed
2026-09-26: Chrome headless aborts on launch (`Abort trap: 6`, exit 134,
including with `--no-sandbox --no-zygote --single-process`), `qlmanage -t`
fails sandbox initialization, no other engine is installed (no Playwright
browsers, no `wkhtmltoimage`, no pyobjc WebKit, broken simulator CLI), and
there is no network to fetch tooling. To attach the AC7 pixels to the PR,
open both fixture files in a browser at 360px width on any machine with a
renderer and screenshot the `ready-4` section (plus `exhausted-and-na` to
show the logo stays identifiable in exhausted/N/A states); save them next
to the fixtures as `capacity-header-before.png` /
`capacity-header-after.png`.

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
