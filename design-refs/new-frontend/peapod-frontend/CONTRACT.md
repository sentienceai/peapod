# Build contract — read before writing a line

This frontend is a **faithful build of the Peapod design frames**, in the stack the product
already uses: plain HTML, plain CSS, ES modules loaded straight from disk. **No framework, no
bundler, no npm dependency, no build step.** A file is served exactly as it sits.

## Where things are

```
peapod-frontend/
  index.html          landing            (frame: landing.dc.html)
  leaderboard.html    the board          (frame: leaderboard.dc.html)
  copy-trade.html     copy grid          (frame: copy-trade.dc.html)
  asset.html          asset + holders    (frame: asset-holders.dc.html)
  styles/tokens.css   the palette. NEVER edit; never write a colour literal anywhere else.
  styles/base.css     reset, type, top bar, buttons, chips, tabs, cards, medals, evidence bar
  styles/<page>.css   one per page/component, added by whoever builds it
  lib/theme.js        day/night: mountTheme(host), current(), HEAD_SNIPPET
  lib/format.js       node, el, money, compact, pct, signed, signedPct, shortAddr, ago,
                      duration, stamp, assetTile, token, icon, ICONS, copyButton
  lib/data.js         THE ONLY DATA SOURCE. meta(), board(), trader(addr), assets(),
                      assetDetail(symbol), search(q), isSample()
  lib/mock.js         the deterministic dataset behind data.js — do not import it directly
  lib/spark.js        sparkline(series, opts), areaChart(series, opts)
  lib/chrome.js       mountChrome(host, {current, onSearch}), mountFoot(host, meta)
```

The frames are at `/home/claude/peapod-src/design-refs/peapod-design-handoff/screens/*.dc.html`.
They are HTML with inline styles and `{{holes}}` for data — **read the numbers out of them**:
every padding, height, radius and font size in a frame is a decision, not a suggestion. The
`{{hole}}` syntax and the `<x-dc>` wrapper are canvas machinery; drop them.

## The rules the design is drawn on

1. **One accent.** `--accent` is the copy action. `--up` is the positive sign. They are never
   swapped, and there is no third green.
2. **A signed figure is the only coloured figure.** Win rates, shares, coverage bars and
   counts stay in the neutral channel, so colour means direction and only direction. Build
   every signed figure with `signed()` from `lib/format.js` — it carries the colour, the
   ▲/▼ glyph and the explicit + or − together.
3. **Rectangles**: `--radius-control-sm` 8px on controls, `--radius-button` 10px on buttons,
   `--radius-panel` 14px on panels, `--radius-card` 20px on floating cards. Circles only for
   things round by nature — avatars, asset tiles, status dots, holder bubbles.
4. **Figures are mono and tabular; prose is not.** Use the `.mono` / `.num` class or
   `font-family: var(--font-mono)`. Never set tabular figures on a container of prose: the
   body face gives commas a digit's width in tabular mode and sentences come out gappy.
5. **Colour is never the only channel.** A rank carries its numeral, a verdict carries its
   words, a sign carries its glyph.
6. **No colour literal outside `styles/tokens.css`.** If a frame drew one inline, add it to
   tokens.css with a comment, or use the nearest token and say why in a comment.
7. **Spot only.** No perps, no leverage, no funding rate, no liquidation price — this product
   looks at wallets trading tokenized equities and Pons memecoins. If a frame ever shows one,
   it is a leftover from the reference screenshots: drop it.

## How a page is put together

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>… · Peapod</title>
<link rel="icon" href="/favicon.svg">
<script>/* the exact HEAD_SNIPPET string from lib/theme.js, inline, before any stylesheet */</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital,wght@0,400;1,400&family=JetBrains+Mono:wght@400;500&family=Schibsted+Grotesk:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/styles/tokens.css">
<link rel="stylesheet" href="/styles/base.css">
<link rel="stylesheet" href="/styles/<page>.css">
<script type="module" src="/lib/<page>.js"></script>
</head>
<body>
<header id="chrome"></header>
<main …>…</main>
<footer id="foot"></footer>
</body>
</html>
```

The page module calls `mountChrome(el('chrome'), { current: '<nav id>', onSearch })` and
`mountFoot(el('foot'), await meta())`, then renders its own content from `lib/data.js`.

## House style, which is not optional here

- **JSDoc types on every exported function and every non-obvious local.** `npm run lint` is
  `tsc --noEmit` over JS; unannotated `any` slipping through is not the bar.
- **Comments explain the decision, not the syntax.** Say why a value is what it is, what was
  tried before, and what breaks if it changes. A comment that restates the line below it is
  noise; a comment that says "48% was drawn for a proportional face and the figures are mono
  now" is the reason the next person does not undo the fix.
- Build DOM with `node()` / `document.createElement`, never `innerHTML` with interpolated
  data. Inline SVG through `icon()`.
- Everything the user can click is reachable by keyboard and says what it is (`aria-label`,
  `aria-pressed`, `role`). Dialogs trap focus and close on Escape and on a backdrop click.
- Nothing in this frontend places, copies or simulates a trade. A control that would needs to
  say what it is waiting for rather than pretending.
- Responsive: the frames are drawn at 1440. Below 1280 a 4-column grid becomes 3, below 1024
  it becomes 2, below 768 one, and the page keeps 16px gutters. No horizontal scroll, ever.

## What "done" means for a screen

- It renders from `lib/data.js` with no console error, in **both themes**.
- Nothing overflows its box at 1440, 1280, 1024 and 390 wide.
- Every figure on it can be traced to a field `lib/data.js` actually returns.
- It matches the frame: same sections in the same order, same proportions, same weights.
