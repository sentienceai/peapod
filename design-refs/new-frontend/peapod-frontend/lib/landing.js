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
 */

import { board, meta, assets } from './data.js';
import { mountChrome, mountFoot } from './chrome.js';
import {
  node, el, compact, pct, signed, signedPct, shortAddr, token,
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
  let matchedVolume = 0;
  let roundTrips = 0;
  for (const r of boardData.rows) { matchedVolume += r.matchedVolume; roundTrips += r.roundTrips; }
  const items = [
    { label: `MATCHED VOLUME · ${boardData.window.toUpperCase()}`, value: compact(matchedVolume) },
    { label: 'WALLETS QUALIFYING', value: Number(metaData.addressesQualifying).toLocaleString('en-US') },
    { label: 'TOKENS TRACKED', value: String(assetList.length) },
    { label: 'ROUND-TRIPS CLOSED', value: roundTrips.toLocaleString('en-US') },
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
function renderExplore(host, row, assetList) {
  if (!host || !row) return;
  const kindOf = new Map(assetList.map((a) => [a.symbol, a.kind]));
  const panel = node('div', 'lp-mock-panel');
  const top = node('div', 'lp-mock-row');
  top.append(node('span', 'avatar', initials(row.address)));
  const id = node('div', 'lp-mock-id');
  id.append(node('span', 'lp-mock-name', shortAddr(row.address)), node('span', 'mono lp-mock-sub', `Rank #${row.rank}`));
  top.append(id, signed(row.realized, 'lp-mock-pnl'));
  panel.append(top);

  const chips = node('div', 'lp-token-row');
  for (const sym of row.tokens.slice(0, 5)) {
    chips.append(token({ symbol: sym, kind: kindOf.get(sym) ?? 'stock' }));
  }
  panel.append(chips);

  const badge = node('div', 'lp-float-badge');
  badge.append(node('span', 'lp-float-label', `Win rate · ${row.roundTrips} closes`));
  badge.append(node('span', 'lp-float-value', pct(row.winRate)));
  host.replaceChildren(panel, badge);
}

/**
 * One tile in the markets grid, for a stock/ETF or memecoin asset row from assets().
 * @param {any} a
 */
function tileForAsset(a) {
  const tile = node('div', 'lp-mtile');
  const top = node('div', 'lp-mtile-top');
  top.append(node('span', `asset-tile asset-tile--${a.kind} asset-tile--lg`, a.symbol.slice(0, 2)));
  top.append(node('span', 'mono lp-mtile-idx', `#${a.rank}`));
  tile.append(top);
  tile.append(node('span', 'lp-mtile-title', a.name));
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
  const stocks = byVolume(assetList.filter((a) => a.kind === 'stock' || a.kind === 'etf')).slice(0, 5);
  const memes = byVolume(assetList.filter((a) => a.kind === 'meme')).slice(0, 5);
  el('panel-stocks')?.replaceChildren(...stocks.map(tileForAsset));
  el('panel-memes')?.replaceChildren(...memes.map(tileForAsset));
  el('panel-wallets')?.replaceChildren(...boardRows.slice(0, 5).map(tileForWallet));
}

/**
 * "Built for signal": addresses seen, addresses that qualified, tokens tracked. The fourth
 * frame stat ("24/7 markets covered") needs no figure at all and stays static markup in
 * index.html instead of being duplicated here.
 * @param {HTMLElement | null} host @param {Awaited<ReturnType<typeof meta>>} metaData
 * @param {Awaited<ReturnType<typeof assets>>} assetList
 */
function renderSignalStats(host, metaData, assetList) {
  if (!host) return;
  const items = [
    { value: Number(metaData.addressesSeen).toLocaleString('en-US'), label: 'ADDRESSES SEEN' },
    { value: Number(metaData.addressesQualifying).toLocaleString('en-US'), label: 'CLOSED A ROUND-TRIP' },
    { value: String(assetList.length), label: 'TOKENS TRACKED' },
    { value: '24/7', label: 'MARKETS COVERED' },
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
    || !('IntersectionObserver' in window)) return;

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
  mountFoot(el('foot'), metaData);

  renderHeroStats(el('hero-stats'), boardData, metaData, assetList);
  renderPodium(el('hero-podium'), boardData.rows);
  renderHeroTable(el('hero-table'), boardData.rows);
  renderExplore(el('explore-mini'), boardData.rows[0], assetList);
  renderSignalStats(el('signal-stats'), metaData, assetList);
  renderMarkets(assetList, boardData.rows);

  initReveal();
}

main().catch((err) => {
  // A landing page that throws past its own chrome is worse than one that logs and leaves the
  // static prose standing — every section's words are already in the markup either way.
  console.error('landing: failed to render live data', err);
});
