# Peapod design handoff

This folder holds the approved Peapod designs. Use it to reskin the existing site. The backend and real data stay as they are. Only the presentation layer changes.

## What is in here

| File | What it is |
|---|---|
| `tokens.css` | Every color, font, radius and shadow. Light is the default. Dark mode applies with `data-theme="dark"` on `<html>`. |
| `screens/landing.dc.html` | Marketing landing page |
| `screens/leaderboard.dc.html` | Leaderboard (top 3 podium, ranked table) |
| `screens/copy-trade.dc.html` | Copy trade grid (4 cards per row) and list view |
| `screens/trader-profile.dc.html` | Wallet profile, opens as a large modal |
| `screens/copy-setup.dc.html` | 2-step Copytrade / Countertrade setup modal |
| `screens/asset-holders.dc.html` | Asset page with the holder bubble cluster |
| `screens/search.dc.html` | Search palette (Assets and Traders tabs) |

## How to read the screen files

The `.dc.html` files are design mockups, not production code. Treat them as the visual spec.

- Markup between `<x-dc>` and `</x-dc>` is the layout. All styling is inline, so exact sizes, spacing, radii and colors are right there.
- `{{name}}` is a value filled in by the `<script data-dc-script>` block at the bottom of each file.
- `<sc-for list="{{items}}" as="item">` is a loop. `<sc-if value="{{flag}}">` is a conditional.
- `<dc-import name="TraderModal">` mounts another screen as a child (for example, the profile inside the leaderboard).
- The `renderVals()` script shows the logic for each view: sorting, filters, formatting, chart paths, bubble packing, wizard steps.
- **All numbers, names, addresses and prices in the scripts are sample data.** Replace them with the real API data. Never ship the sample arrays.

## Rules to follow

1. **Use the tokens.** No hard-coded hex values in components. Map every color to a `tokens.css` variable so day and night mode both work.
2. **Fonts.** Instrument Serif for large headlines only (italic accent words in `--accent`). Schibsted Grotesk for UI. JetBrains Mono for numbers, addresses and uppercase labels.
3. **Numbers.** Money and percentages use the mono font. Gains use `--up`, losses use `--down`. Positive values show a leading `+`.
4. **Buttons are rounded rectangles** (`--radius-button`, 8px for small controls). Only avatars, status dots, asset icons, medals, bubbles and on/off switches are round.
5. **Primary button** is `--inv-bg` with `--inv-fg` text (flips in dark mode). Accent-green buttons are for copy actions only. Countertrade uses `--loss-fill`.
6. **Scope is spot only.** Tokenized stocks, ETFs, crypto and Pons memecoins on Robinhood Chain. No leverage, margin, liquidation or funding anywhere.
7. **Funding tokens** are USDG and ETH.
8. **Accessibility.** Real `<button>` and `<a>` elements, labels on inputs, `aria-label` on icon-only buttons.

## Global behavior

- **Theme switch** (sun/moon pill in every top bar). Saves to `localStorage` key `peapod-theme` and applies site-wide.
- **Search bar** in the app top bar opens the search palette. Supports arrow keys, Enter, Tab (switch tab), Esc. Also open it on `/` and Cmd/Ctrl+K.
- **Modals** sit on a dimmed backdrop above all page content (high z-index). Clicking the backdrop or Esc closes them.
- **Navigation flow**
  - Leaderboard row or podium card → trader profile
  - Copy trade card body → trader profile. Card "Copy" button → copy setup. "Copying" button → stop copying
  - Trader profile "Copy this trader" → copy setup
  - Search trader → trader profile. Search asset → asset page
  - Asset page bubble, top holder row or recent trade wallet → trader profile
- **Profiles and assets should have real URLs** (for example `/trader/:address` and `/asset/:symbol`) that open in the modal when reached from inside the app and as a full page when opened directly.

## Data each screen needs

- **Leaderboard:** rank, name or address, portfolio value, net realized PnL, volume, win rate, trade count, top assets, PnL series for podium charts. Filters: category (stocks, memecoins), timeframe (24H, 7D, 30D, YTD, All), $ or %.
- **Copy trade:** per trader: copy score (0 to 100), last trade time, 30D PnL and ROI, portfolio value, assets, PnL series. Tabs and sort as in the file.
- **Trader profile:** portfolio value and breakdown (stocks, memecoins, cash), holdings table (balance, value, avg cost, price, unrealized and realized PnL, % of portfolio, 24H), realized and total PnL series, win/loss sequence, portfolio mix, buy/sell flow, concentration, analysis stats, drawdown, Sharpe.
- **Copy setup:** trader stats, simulated return series, user wallet balance in USDG and ETH, settings payload (max size per trade, include memecoins, only new positions, max worse entry, per-asset toggles, stop loss, take profit, inactivity pause, alerts).
- **Asset page:** price, 24H change, price series, holder count, 24H volume, % holders in profit, average entry, list of holders with position value and PnL %, recent trades.
- **Search:** assets list and traders list, both filterable by text.

## Suggested order of work

1. Add `tokens.css`, fonts and the theme switch. Confirm light and dark both work.
2. Build shared pieces: top bar with search, buttons, segmented controls, tabs, pills, asset icon, avatar, copy score bar, sparkline and area chart, modal shell.
3. Reskin leaderboard, then copy trade, then trader profile, wiring each to the existing data.
4. Build the copy setup flow, search palette and asset page.
5. Landing page last.
6. Check every screen in both themes and at a narrow width before calling it done.

## Open items

- Copy score, simulated return and "in profit" definitions need to come from the backend.
- Minimum balance for connecting an existing wallet is still a placeholder.
- Landing page stats, API numbers, pricing, support email and custody answer are placeholders marked `[X]` or in brackets.
- Mobile layouts were not designed. Stack columns and keep the same tokens.
