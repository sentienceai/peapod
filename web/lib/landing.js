/**
 * The landing page (frame: landing.dc.html).
 *
 * This screen is almost entirely CSS: the words, the section order and the two illustrative
 * mockups (the copy-setup card, the rule builder) are static markup in index.html because a
 * marketing page should render its sentences without waiting on a module. What this file adds
 * is the handful of places the frame drew a NUMBER — the hero's mini dashboard, the "Built for
 * signal" strip and the markets grid — and every one of those numbers is read from board(),
 * meta() and assets() rather than typed in, because a plausible figure with nothing behind it
 * is the one thing this build refuses to ship (see lib/data.js's own header on this).
 *
 * WHAT THE FRAME DREW THAT THIS FILE DROPS OR CHANGES, and why:
 *   - The hero dashboard's "+12.4% / +8.9% / +46 / +21.0%" delta chips. Nothing in lib/data.js
 *     hands back a PRIOR period to diff against — board() is one window, not two — so a delta
 *     next to a real figure would be the exact kind of number this build refuses to invent.
 *   - "Copy score 95" on the copy-setup mockup. No score field exists anywhere in mock.js (see
 *     lib/profile.js's own comment: "a copy score belongs to copy-setup.js, not here" — and
 *     copy-setup.js never adds one either). The mockup shows the budget presets and the two
 *     toggles the real wizard actually has instead.
 *   - The "Strategies" tab in the markets grid and the API section's request-per-second /
 *     latency stat. Both were drawn as literal "[X]" holes in the frame — an unresolved
 *     placeholder, not a figure this build could ever compute — so the tab is dropped and the
 *     API section keeps its code sample without a stats row.
 *   - Every specific dollar figure on the two "coming soon" mockups (a phone's "$12,480.35"
 *     balance, a copy-trade toast's "-$500.00"). Nobody is signed in on a marketing page, so a
 *     personal balance has no real number behind it at any window; the mockups keep the shapes
 *     (a chart, an activity feed) and drop the invented amounts.
 *
 * THE LABELS ARE PART OF THE FIGURE. A true number under a label that reads wider than it is
 * still says something false, so each label here names what its number counts: the window's
 * matched volume comes from the build's own coverage block rather than a sum over the ranked
 * rows, the round-trip sum says how many rows it added up, and the strip's last cell prints the
 * window the board is ranked over instead of the frame's "24/7".
 */

import { board, meta, assets, trader } from './data.js';
import { mountChrome, mountFoot } from './chrome.js';
import {
  node, el, compact, pct, signed, signedPct, shortAddr, token, assetTile,
} from './format.js';
import { sparkline } from './spark.js';

/**
 * A price at whatever precision it needs to not read as $0.00 — lib/format.js's money() is
 * built for security-grade prices ($20–$800) and rounds a Pons memecoin's fractional price to
 * nothing. Kept local rather than added to format.js because this build does not touch shared
 * files (see asset-page.js's fmtPrice() for the same reasoning on the asset page).
 * @param {number} n
 */
function fmtPrice(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

/**
 * The fields the callbacks below read off one assets() row. lib/data.js hands that list back
 * untyped — the live endpoint's rows arrive as JSON — so the shape is named here rather than
 * inferred, and it names only what is read, so it stays true whatever else that row carries.
 * @typedef {{symbol: string, kind: string}} AssetRow
 */

/** The two hex characters after "0x", the only initials an address actually offers. */
const initials = (/** @type {string} */ addr) => addr.slice(2, 4).toUpperCase();

/**
 * The hero dashboard's four stat cards: matched volume, qualifying wallets, tokens tracked and
 * round-trips closed, all summed or read straight from what board()/meta()/assets() return.
 * @param {HTMLElement | null} host
 * @param {Awaited<ReturnType<typeof board>>} boardData
 * @param {Awaited<ReturnType<typeof meta>>} metaData
 * @param {Awaited<ReturnType<typeof assets>>} assetList
 */
function renderHeroStats(host, boardData, metaData, assetList) {
  if (!host) return;
  let rowVolume = 0;
  let roundTrips = 0;
  for (const r of boardData.rows) { rowVolume += r.matchedVolume; roundTrips += r.roundTrips; }
  /*
   * "MATCHED VOLUME · 7D" is a claim about the window, and the window's matched volume is a
   * figure the build already publishes — so it is read from the coverage block rather than
   * summed off the rows, which the build caps at a thousand. A payload without coverage (the
   * mock, an older store) has only the rows, and there the label says how many it added up.
   */
  const ranked = boardData.rows.length.toLocaleString('en-US');
  const windowVolume = Number(boardData.coverage?.matched_volume_usd);
  const volume = Number.isFinite(windowVolume) && windowVolume > 0
    ? { label: `MATCHED VOLUME · ${boardData.window.toUpperCase()}`, value: compact(windowVolume) }
    : { label: `MATCHED VOLUME · TOP ${ranked}`, value: compact(rowVolume) };
  const items = [
    volume,
    // From the SAME coverage block as the volume above it and as the leaderboard's own
    // caveat. The manifest's count is every address with a detail record, which is a wider
    // set than the window being ranked — two true numbers that read as one disagreeing with
    // itself when they sit in the same strip. Falls back to the manifest when a store
    // predating the coverage block answers.
    { label: 'WALLETS QUALIFYING',
      value: Number(boardData.coverage?.addresses_qualifying ?? metaData.addressesQualifying)
        .toLocaleString('en-US') },
    { label: 'TOKENS TRACKED', value: String(assetList.length) },
    // Summed off the rows, and there is no window-wide count of closes to read instead, so
    // this one says how many rows it covers rather than reading as every close in the window.
    { label: `ROUND-TRIPS · TOP ${ranked}`, value: roundTrips.toLocaleString('en-US') },
  ];
  host.replaceChildren(...items.map((s) => {
    const card = node('div', 'lp-hstat');
    card.append(node('span', 'mono lp-hstat-label', s.label), node('span', 'lp-hstat-value', s.value));
    return card;
  }));
}

/**
 * The top three board rows as the frame's podium: rank medal, realized PnL and the row's own
 * closed-PnL series drawn with lib/spark.js's sparkline() — reused as-is so the line's colour
 * still follows the one rule it is built on (the sign of where the series ended).
 * @param {HTMLElement | null} host @param {any[]} rows
 */
function renderPodium(host, rows) {
  if (!host) return;
  host.replaceChildren(...rows.slice(0, 3).map((r, i) => {
    const card = node('div', 'lp-podium-card');
    const top = node('div', 'lp-podium-top');
    top.append(node('span', 'avatar', initials(r.address)));
    top.append(node('span', 'lp-podium-name', shortAddr(r.address)));
    top.append(node('span', `medal medal--${i + 1}`, String(i + 1)));
    card.append(top);
    const bottom = node('div', 'lp-podium-bottom');
    const fig = node('div', 'lp-podium-fig');
    fig.append(signed(r.realized, 'lp-podium-pnl'));
    fig.append(node('span', 'lp-podium-fig-label', `Realized · ${r.roundTrips} closes`));
    bottom.append(fig, sparkline(r.series, { width: 200, height: 84 }));
    card.append(bottom);
    return card;
  }));
}

/**
 * Ranks 4–7, the rows right under the podium: the same four columns lib/copy-page.js's own grid
 * settled on (rank, trader, net PnL, matched volume, win rate) — this board has no priced
 * "portfolio" figure, so that frame column is dropped here too rather than invented.
 * @param {HTMLElement | null} host @param {any[]} rows
 */
function renderHeroTable(host, rows) {
  if (!host) return;
  host.replaceChildren(...rows.slice(3, 7).map((r) => {
    const row = node('div', 'lp-hrow');
    row.append(node('span', 'mono', String(r.rank)));
    row.append(node('span', 'lp-hrow-name', shortAddr(r.address)));
    row.append(signed(r.realized, 'lp-hrow-num'));
    row.append(node('span', 'mono lp-hrow-num', compact(r.matchedVolume)));
    row.append(node('span', 'mono lp-hrow-num', pct(r.winRate)));
    return row;
  }));
}

/**
 * The "Explore" feature card's mini wallet mockup: the board's own #1 row, its real tokens and
 * its real win rate — the frame's fictional "thetaGang / $1.10M / 61.4%" replaced with the
 * actual top of the actual board.
 * @param {HTMLElement | null} host @param {any} row @param {Awaited<ReturnType<typeof assets>>} assetList
 */
function renderExplore(host, row, assetList, /** @type {any} */ detail) {
  if (!host || !row) return;
  const kindOf = new Map(assetList.map((/** @type {AssetRow} */ a) => [a.symbol, a.kind]));
  const panel = node('div', 'lp-mock-panel');
  const top = node('div', 'lp-mock-row');
  top.append(node('span', 'avatar', initials(row.address)));
  const id = node('div', 'lp-mock-id');
  id.append(node('span', 'lp-mock-name', shortAddr(row.address)), node('span', 'mono lp-mock-sub', `Rank #${row.rank}`));
  top.append(id, signed(row.realized, 'lp-mock-pnl'));
  panel.append(top);

  /*
   * THE MIX BAR, WHICH IS THE FRAME'S AND IS ALSO MEASURED.
   *
   * Landing.dc.html draws a wallet's holdings split — NVDA 34%, HOOD 24%, and so on — over a
   * portfolio value. A holdings split needs balances, which need the transfer index. What
   * the build does publish per wallet is matched volume per token: how much of the money
   * this address actually round-tripped went through each one. That is a real mix of a real
   * wallet, so the bar is drawn from it and the caption says which mix it is, rather than
   * letting a reader take it for a portfolio.
   */
  const stats = (detail?.tokenStats ?? []).filter((/** @type {any} */ t) => t.matched > 0)
    .sort((/** @type {any} */ a, /** @type {any} */ b) => b.matched - a.matched);
  const total = stats.reduce((/** @type {number} */ sum, /** @type {any} */ t) => sum + t.matched, 0);
  if (total > 0) {
    const shown = stats.slice(0, 5);
    const bar = node('div', 'lp-mix-bar');
    bar.setAttribute('aria-hidden', 'true');
    shown.forEach((/** @type {any} */ t, /** @type {number} */ i) => {
      const seg = node('i', `lp-mix-seg lp-mix-seg--${i + 1}`);
      seg.style.flexGrow = String(t.matched / total);
      bar.append(seg);
    });
    panel.append(bar);
    const legend = node('div', 'lp-mix-legend');
    shown.forEach((/** @type {any} */ t, /** @type {number} */ i) => {
      const item = node('div', 'lp-mix-item');
      item.append(node('i', `lp-mix-dot lp-mix-seg--${i + 1}`));
      item.append(node('span', 'lp-mix-sym', t.symbol));
      item.append(node('span', 'mono lp-mix-pct', pct(t.matched / total * 100, 0)));
      legend.append(item);
    });
    panel.append(legend);
    panel.append(node('span', 'lp-mix-caption', 'Share of matched volume, by token'));
  } else {
    const chips = node('div', 'lp-token-row');
    for (const sym of row.tokens.slice(0, 5)) {
      chips.append(token({ symbol: sym, kind: kindOf.get(sym) ?? 'stock' }));
    }
    panel.append(chips);
  }

  const badge = node('div', 'lp-float-badge');
  badge.append(node('span', 'lp-float-label', `Win rate · ${row.roundTrips} closes`));
  badge.append(node('span', 'lp-float-value', pct(row.winRate)));
  host.replaceChildren(panel, badge);
}

/**
 * One tile in the markets grid, for a stock/ETF or memecoin asset row from assets().
 *
 * TWO FIELDS THAT ONLY EVER EXISTED IN THE MOCK. This drew `#${a.rank}` and `a.name`, and
 * /api/assets carries neither: a row is symbol, kind, price, change24h, volume24h, volume,
 * traders, trades. So every tile printed "#undefined" and had no title at all — the markets
 * grid on the front page did not name a single token. The rank is now the token's place in
 * the market list by 24h volume, which the endpoint already orders by and the caller passes
 * in; the title is the ticker, because no name field exists anywhere in this build.
 * @param {any} a @param {number} rank its position in the whole market list, 1-based
 */
function tileForAsset(a, rank) {
  const tile = node('div', 'lp-mtile');
  const top = node('div', 'lp-mtile-top');
  top.append(assetTile(a.symbol, a.kind, 'asset-tile--lg'));
  top.append(node('span', 'mono lp-mtile-idx', `#${rank}`));
  tile.append(top);
  tile.append(node('span', 'mono lp-mtile-title', a.symbol));
  tile.append(node('span', 'lp-mtile-sub', a.kind === 'meme' ? 'Pons memecoin' : 'Tokenized equity'));
  tile.append(node('div', 'spacer'));
  const bottom = node('div', 'lp-mtile-bottom');
  bottom.append(node('span', 'mono lp-mtile-price', fmtPrice(a.price)));
  bottom.append(signedPct(a.change24h));
  tile.append(bottom);
  tile.append(node('span', 'mono lp-mtile-foot', `Vol ${compact(a.volume24h)} · ${a.traders} traders`));
  return tile;
}

/**
 * One tile in the markets grid's "Wallets" tab: a board row, not an asset.
 * @param {any} r
 */
function tileForWallet(r) {
  const tile = node('div', 'lp-mtile');
  const top = node('div', 'lp-mtile-top');
  top.append(node('span', 'avatar', initials(r.address)));
  top.append(node('span', 'mono lp-mtile-idx', `#${r.rank}`));
  tile.append(top);
  tile.append(node('span', 'lp-mtile-title', shortAddr(r.address)));
  tile.append(node('span', 'lp-mtile-sub', `${r.roundTrips} round-trips closed`));
  tile.append(node('div', 'spacer'));
  const bottom = node('div', 'lp-mtile-bottom');
  bottom.append(signed(r.realized, undefined, compact));
  bottom.append(node('span', 'mono lp-mtile-pill', `${pct(r.winRate, 0)} win`));
  tile.append(bottom);
  return tile;
}

/**
 * The three market-grid panels. Tab switching itself is plain CSS (radio inputs the labels sit
 * next to — see styles/landing.css) so this only has to fill each panel once.
 * @param {Awaited<ReturnType<typeof assets>>} assetList @param {any[]} boardRows
 */
function renderMarkets(assetList, boardRows) {
  const byVolume = (/** @type {any[]} */ list) => list.slice().sort((a, b) => b.volume24h - a.volume24h);
  // One ranking over every token, so a memecoin tile saying #7 means seventh on the chain
  // rather than seventh among memecoins.
  const ranked = byVolume(assetList);
  const rankOf = new Map(ranked.map((/** @type {any} */ a, i) => [a.symbol, i + 1]));
  const tileWithRank = (/** @type {any} */ a) => tileForAsset(a, rankOf.get(a.symbol) ?? 0);
  const stocks = ranked.filter((/** @type {AssetRow} */ a) => a.kind === 'stock' || a.kind === 'etf').slice(0, 5);
  const memes = ranked.filter((/** @type {AssetRow} */ a) => a.kind === 'meme').slice(0, 5);
  el('panel-stocks')?.replaceChildren(...stocks.map(tileWithRank));
  el('panel-memes')?.replaceChildren(...memes.map(tileWithRank));
  el('panel-wallets')?.replaceChildren(...boardRows.slice(0, 5).map(tileForWallet));
}

/**
 * "Built for signal": addresses seen, addresses that qualified, tokens tracked, and the window
 * the board is ranked over. The frame's four cells are "[X]M+ wallets indexed", "[X]M+ trades
 * tracked", "<[X]s data freshness" and "24/7 markets covered" — three unresolved placeholders
 * and an uptime, so every cell here is a figure the build can actually answer with instead.
 * @param {HTMLElement | null} host @param {Awaited<ReturnType<typeof board>>} boardData
 * @param {Awaited<ReturnType<typeof meta>>} metaData
 * @param {Awaited<ReturnType<typeof assets>>} assetList
 */
function renderSignalStats(host, boardData, metaData, assetList) {
  if (!host) return;
  // Same source as the hero strip and the leaderboard's caveat: the window's own coverage.
  const c = boardData.coverage;
  const items = [
    { value: Number(c?.addresses_seen ?? metaData.addressesSeen).toLocaleString('en-US'),
      label: 'ADDRESSES SEEN' },
    { value: Number(c?.addresses_qualifying ?? metaData.addressesQualifying).toLocaleString('en-US'),
      label: 'CLOSED A ROUND-TRIP' },
    { value: String(assetList.length), label: 'TOKENS TRACKED' },
    // The frame's "24/7 / MARKETS COVERED" is an uptime, and nothing measures it. The window
    // the board is ranked over is a real fact the manifest already carries.
    { value: String(metaData.windowLabel), label: 'RANKING WINDOW' },
  ];
  host.replaceChildren(...items.map((s, i) => {
    const cell = node('div', i ? 'lp-strip-cell lp-strip-cell--rule' : 'lp-strip-cell');
    cell.append(node('span', 'lp-strip-value', s.value), node('span', 'mono lp-strip-label', s.label));
    return cell;
  }));
}

/**
 * A light fade/rise on scroll for the sections marked `.lp-reveal`. Strictly additive: every
 * one of those elements is fully visible with NO JS at all, because landing.css never hides
 * `.lp-reveal` on its own — only under the `js-reveal` class this function adds to `<html>`,
 * and only after reconciling which sections are already on screen. That order matters: a full-
 * page render, a reader who lands mid-page from an anchor, an IntersectionObserver that never
 * gets a chance to fire (or doesn't exist), or `prefers-reduced-motion` must all still show
 * everything, so the animated state is opt-in machinery layered on top of an always-visible
 * page rather than a hide-first-and-hope-the-observer-fires one.
 */
function initReveal() {
  const targets = Array.from(document.querySelectorAll('.lp-reveal'));
  if (!targets.length) return;
  const reveal = (/** @type {Element} */ t) => t.classList.add('is-visible');

  // Reduced motion (or no observer support): never arm the hide rule at all, so nothing is
  // ever at opacity 0 for even one frame — the safest form of "immediately visible".
  if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    || !('IntersectionObserver' in globalThis)) return;

  // Whatever is already on screen (or close to it) reveals BEFORE `js-reveal` goes on the
  // document, so enabling the hide-then-animate rule next paint never hides something the
  // reader is already looking at.
  const vh = globalThis.innerHeight || document.documentElement.clientHeight || 0;
  for (const t of targets) {
    const r = t.getBoundingClientRect();
    if (r.top < vh && r.bottom > 0) reveal(t);
  }
  document.documentElement.classList.add('js-reveal');

  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      reveal(entry.target);
      io.unobserve(entry.target);
    }
  }, { threshold: 0.01, rootMargin: '0px 0px 40% 0px' });
  for (const t of targets) if (!t.classList.contains('is-visible')) io.observe(t);

  // Failsafe: a section the observer never got around to (a render tool that never scrolls,
  // a tab that never regains visibility, an observer callback that silently never fires) is
  // still visible by the time the page has fully loaded — no exceptions, no blank sections.
  globalThis.addEventListener?.('load', () => targets.forEach(reveal), { once: true });
}

async function main() {
  mountChrome(el('chrome'), { current: 'home' });

  const [boardData, metaData, assetList] = await Promise.all([board(), meta(), assets()]);
  /*
   * The explore mock wants a wallet with more than one token in it, because the mix bar is
   * the point of that card; rows[0] on this tape traded exactly one. It is still a real,
   * ranked wallet and the card says which rank it is.
   */
  const mixRow = boardData.rows.find((/** @type {any} */ r) => (r.tokens?.length ?? 0) >= 3)
    ?? boardData.rows[0];
  const mixDetail = mixRow ? await trader(mixRow.address).catch(() => null) : null;
  mountFoot(el('foot'), metaData);

  renderHeroStats(el('hero-stats'), boardData, metaData, assetList);
  renderPodium(el('hero-podium'), boardData.rows);
  renderHeroTable(el('hero-table'), boardData.rows);
  renderExplore(el('explore-mini'), mixRow, assetList, mixDetail);
  renderSignalStats(el('signal-stats'), boardData, metaData, assetList);
  renderMarkets(assetList, boardData.rows);

  initReveal();
}

main().catch((err) => {
  // A landing page that throws past its own chrome is worse than one that logs and leaves the
  // static prose standing — every section's words are already in the markup either way.
  console.error('landing: failed to render live data', err);
});
