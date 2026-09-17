# Peapod — the frontend, built from the design frames

Every screen in the Peapod design canvas, built as a working site: plain HTML, plain CSS and
ES modules loaded straight from disk. **No framework, no bundler, no npm dependency, no build
step** — the file that is served is the file that was written.

```
node serve.mjs          # → http://127.0.0.1:4180   (any static server does; this one is 30 lines)
```

## The screens

| Page | File | What it is |
| --- | --- | --- |
| Landing | `index.html` | the marketing page |
| Leaderboard | `leaderboard.html` | the board: podium, sortable ranking, filters |
| Copy trade | `copy-trade.html` | four landscape cards per row, and the copy action |
| Asset | `asset.html?symbol=TSLA` | the asset, its holder cluster and its tape |
| Trader profile | `lib/profile.js` | a dialog, opened from any row, card or bubble |
| Copy setup | `lib/copy-setup.js` | the two-step window, opened from any Copy button |
| Search | `lib/search.js` | the palette: `/` or ⌘K anywhere, Assets and Traders |

Day and night on every one of them, remembered per reader, applied before first paint.

## Where the data comes from, and how to point it at yours

**`lib/data.js` is the only seam.** No page fetches anything; no page knows a URL. Today it
answers from `lib/mock.js` — one deterministic tape, so every screen and every screenshot
shows the same numbers. Flip `SOURCE` to `'api'` and fill in the four calls:

| Function | Endpoint | State |
| --- | --- | --- |
| `board({universe, window})` | `/api/leaderboard/:scope/:window` | **exists** — `fromApiRow()` already maps the shape |
| `trader(address)` | `/api/address/:address` | **exists** |
| `assets()` | `/api/assets` | needs an endpoint over the swap tape; no new data |
| `assetDetail(symbol)` | `/api/asset/:symbol` | the price and tape parts are computable today; `holders` needs a transfer index |

`isSample()` is true while the mock is on, and every page carries a **Sample data** mark
because of it. Delete the mark when the endpoints land, not before.

The copy flow is built for real — the state machine, the validation, the review step and the
request body are all there — and it stops at the one honest place: **Confirm shows the exact
JSON it would POST and names the endpoint it is waiting for.** Nothing here places, copies or
simulates a trade.

## The rules the build holds itself to

These are in `CONTRACT.md` in full. The short version, because they are the difference
between a design and a set of screens that resemble it:

1. **One accent.** `--accent` is the copy action; `--up` is the positive sign; there is no
   third green. `--accent-text` is the same accent at a contrast that works as a letter.
2. **A signed figure is the only coloured figure.** Win rates, shares, coverage bars and
   verdicts stay neutral, so colour means direction and only direction.
3. **Colour is never the only channel.** A signed figure carries ▲/▼ and its own + or −; a
   rank carries its numeral; a verdict carries its words.
4. **Rectangles**: 8px controls, 10px buttons, 14px panels, 20px floating cards. Circles only
   for things round by nature — avatars, asset tiles, dots, holder bubbles.
5. **Figures are mono and tabular; prose is not.**
6. **No colour literal outside `styles/tokens.css`.**
7. **Spot only** — tokenized equities and Pons memecoins. No perps, leverage or liquidation
   anywhere, including in the frames where the reference screenshots had them.

## What the frames showed and this does not

Three figures in the frames need data that does not exist yet, and each is handled by showing
something true instead of something plausible:

- **Account value** (podium cards, ranking column) needs every ERC-20 transfer on the chain
  and a balance engine over it — most holdings arrived by transfer, issuance or bridge, not
  by swap. The column is **matched volume**, which is measured.
- **Copy score** is not shown at all. A score for copying has to be measured against copies —
  the slippage and delay a follower actually got. In its place is the **chance band**: the
  observed win rate as a mark on a neutral track, with the region a coin-flipper of the same
  number of closes lands in shaded behind it, and the verdict in words.
- **Holder balances** on the asset page are sample data, marked as such, and the page says
  what they will need.

## Files

```
index.html  leaderboard.html  copy-trade.html  asset.html
serve.mjs                 a static server, 30 lines, no dependencies
styles/
  tokens.css              the palette and the scale. Both themes. Edit colour here only.
  base.css                reset, type, top bar, buttons, chips, cards, medals, evidence bar
  board.css  copy.css  asset.css  landing.css  profile.css  search.css
lib/
  data.js                 THE SEAM. mock today, your API tomorrow.
  mock.js                 the deterministic dataset
  theme.js                day/night, the switch, the pre-paint snippet
  format.js               money, price, signed figures, addresses, durations, icons
  spark.js                sparklines and the area chart
  chrome.js               the top bar and the footer
  board.js  copy-page.js  copy-setup.js  asset-page.js  landing.js  profile.js  search.js
CONTRACT.md               the build rules, in full
```

## Checked

Every page renders with no console error, in both themes, at 1440, 1280, 1024 and 390 — no
element overflows its box and no page scrolls sideways. The dialogs trap focus, close on
Escape and on a backdrop click, and return focus to whatever opened them. Every figure on
every screen traces to a field `lib/data.js` returns.
