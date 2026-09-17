/**
 * The copy-trade page (frame: copy-trade.dc.html).
 *
 * WHAT THE FRAME DREW THAT THIS BUILD DROPS, and why:
 *   - The grid/list view toggle and the four filter chips under the control row ("Portfolio
 *     value", "PnL", "All styles", "Copy score"). None of them has a field behind it in
 *     board() — there is no portfolio value, no trading style tag on the row, no copy score —
 *     and a chip that filters nothing is exactly the "control pretending to work" the build
 *     contract rules out. Only the controls the task actually specified are built: universe
 *     tabs, a sort chip, the window segmented control, and an address search field.
 *   - "Largest portfolio" as a sort. board() has no portfolio/account-value field (this
 *     product looks at closed round-trips, not a priced book), so the sort chip cycles through
 *     fields the row actually carries instead: realized PnL, win rate, matched volume, round
 *     trips.
 *   - The chrome's "Copying N · +$184.20" pill and the black wallet-address button in the
 *     frame's own header. Those belong to lib/chrome.js, a shared file this build does not
 *     touch, and chrome.js has no copy-count state to report.
 *
 * WHY THE CARD IS TALLER THAN THE FRAME'S 212PX. The frame's footer carries one numeral (a
 * "copy score" out of 100) and a row of decoration bars. This board has no copy score — what
 * it has instead is the win-rate chance band (evidence.js, exact binomial), a mark on a
 * track plus a verdict sentence plus a footnote, three lines where the frame drew one. The
 * footer grows to fit that honestly rather than truncating the verdict to make 212px true.
 *
 * WHY THE CARD IS ONE BIG BUTTON PLUS TWO SMALL ONES, NOT A BUTTON INSIDE A BUTTON. The frame
 * wraps the whole clickable area in a single <button>, but this card also needs a working
 * copy-address button in the header and a working Copy button in the footer — nesting a
 * <button> inside a <button> is invalid HTML and unreliable to click. Instead `.ct-card-open`
 * is a single button absolutely covering the card (see styles/copy.css), and the header/footer
 * sit on top of it with their own stacking order, so their own buttons take the click and
 * everywhere else falls through to "open profile".
 */

import { board, meta, assets } from './data.js';
import { chanceBand, CRITERION } from './evidence.js';
import { unwired } from './needs.js';
import { openProfile } from './profile.js';
import { openSetup } from './copy-setup.js';
import { sparkline } from './spark.js';
import {
  node, el, icon, ICONS, compact, pct, signed, signedPct, shortAddr, ago, copyButton, assetTile,
} from './format.js';
import { mountChrome, mountFoot } from './chrome.js';

/**
 * @typedef {Object} BoardRow
 * @property {number} rank @property {string} address
 * @property {number} realized @property {number} realizedPct
 * @property {number} matchedVolume @property {number} totalVolume @property {number} coveragePct
 * @property {number} winRate @property {number} wins @property {number} roundTrips
 * @property {string[]} tokens @property {number} tokenCount
 * @property {number} lastTs @property {[number, number][]} series @property {string[]} universes
 */

/**
 * The win-rate slot for one card: an observed rate on a neutral track, the chance band shaded
 * behind it, the verdict in words. Built on .ev / .ev-track / .ev-band / .ev-mark / .ev-null /
 * .ev-verdict / .ev-foot from base.css — the same primitive lib/profile.js's rail uses, so a
 * card and the dialog it opens read as the same test rather than two different widgets.
 *
 * THE VERDICT IS NEVER COLOURED. A verdict is not a signed quantity — rule 2 reserves colour
 * for a signed figure's own + or − — so "Beyond chance" and "Within chance" both stay in the
 * neutral channel; the only difference is weight (var(--fg) vs. var(--muted)), which says
 * "this one found something" without borrowing the up/down channel to say which way.
 *
 * THE FOOTNOTE IS SHORT ON PURPOSE. At card width there is no room next to the Copy button for
 * the method note lib/profile.js's rail spells out in full — that explanation lives in this
 * line's `title` (a hover/long-press tooltip) instead, so the card stays one line without
 * dropping the caveat altogether.
 * @param {BoardRow} row
 */
function chanceRow(row) {
  // THE BAND IS THE EXACT BINOMIAL, from web/lib/evidence.js — the same function the
  // leaderboard, the profile and the criterion text all use. This file used to carry its
  // own normal approximation with a continuity correction, and profile.js carried a second
  // copy of it; two approximations of one test drift apart, and the approximation itself
  // was the bug an earlier pass removed: 0.5 ± 1.96·√(0.25/n) calls four wins from four
  // "beyond chance" when the true probability of that is one in eight. Below six closes no
  // result can clear the bar at all, and the label says so rather than inventing a verdict.
  const b = chanceBand(row.wins, row.roundTrips);
  const wrap = node('div', 'ev');
  const head = node('div', 'ev-head');
  head.append(node('b', undefined, pct(row.winRate, 1)));
  head.append(document.createTextNode('win rate'));
  wrap.append(head);

  const track = node('div', 'ev-track');
  const band = node('div', 'ev-band');
  band.style.left = `${(b.lo * 100).toFixed(1)}%`;
  band.style.width = `${((b.hi - b.lo) * 100).toFixed(1)}%`;
  const mark = node('div', 'ev-mark');
  mark.style.left = `${(b.rate * 100).toFixed(1)}%`;
  track.append(band, node('div', 'ev-null'), mark);
  wrap.append(track);

  // THE VERDICT IS NEVER COLOURED. A verdict is not a signed quantity — colour on this site
  // means direction and only direction — so a finding is marked by weight, not by hue.
  const verdict = node('div', `ev-verdict${b.decisive ? ' ev-verdict-strong' : ''}`, b.label);
  wrap.append(verdict);

  const foot = node('div', 'ev-foot',
    `${row.wins} of ${row.roundTrips} closes · chance ${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}%`);
  foot.title = CRITERION;
  wrap.append(foot);
  return wrap;
}

/** The rows a sort chip can cycle through — every one a field board() actually returns. */
const SORTS = /** @type {const} */ ([
  { id: 'realized', label: 'Highest realized PnL', cmp: (/** @type {BoardRow} */ a, /** @type {BoardRow} */ b) => b.realized - a.realized },
  { id: 'winRate', label: 'Best win rate', cmp: (/** @type {BoardRow} */ a, /** @type {BoardRow} */ b) => b.winRate - a.winRate },
  { id: 'matchedVolume', label: 'Largest matched volume', cmp: (/** @type {BoardRow} */ a, /** @type {BoardRow} */ b) => b.matchedVolume - a.matchedVolume },
  { id: 'roundTrips', label: 'Most round trips', cmp: (/** @type {BoardRow} */ a, /** @type {BoardRow} */ b) => b.roundTrips - a.roundTrips },
]);

const PAGE_SIZE = 16;

const state = {
  /** @type {{id: string, label: string}[]} */ universes: [{ id: 'all', label: 'All' }],
  /** @type {{id: string, label: string}[]} */ windows: [{ id: '7d', label: '7D' }],
  universe: 'all',
  window: '7d',
  sortId: /** @type {string} */ ('realized'),
  query: '',
  visible: PAGE_SIZE,
  /** @type {BoardRow[]} */ rows: [],
  tapeEnd: 0,
  /** Symbol → kind, filled once from assets() so a token chip can pick its pastel. */
  tokenKind: /** @type {Map<string, string>} */ (new Map()),
  /** The three cards in the hero strip — captured once on first load and never re-sorted. */
  heroDone: false,
};

/** @type {HTMLElement} */ let gridEl;
/** @type {HTMLElement} */ let countEl;
/** @type {HTMLButtonElement} */ let sortBtn;
/** @type {HTMLElement} */ let tabsEl;
/** @type {HTMLElement} */ let segEl;
/** @type {HTMLButtonElement} */ let moreBtn;
/** @type {HTMLElement} */ let heroEl;

/** @param {BoardRow[]} rows */
function visibleRows(rows) {
  const q = state.query.trim().toLowerCase();
  const filtered = q ? rows.filter((r) => r.address.toLowerCase().includes(q)) : rows;
  const sort = SORTS.find((s) => s.id === state.sortId) ?? SORTS[0];
  return filtered.slice().sort(sort.cmp);
}

/**
 * One fan card in the hero strip. Decoration only — it carries a short line and a signed
 * figure, never the sparkline the grid card below already draws, because the fan overlaps its
 * own cards by design and a wide chart is exactly what a 20px overlap used to cut into.
 * @param {BoardRow} row @param {number} i position 0..2
 */
function heroCard(row, i) {
  const card = node('div', `hero-fan-card hero-fan-card--${i + 1}`);
  const top = node('div', 'hero-fan-top');
  top.append(node('span', 'avatar avatar--sm mono', row.address.slice(2, 4).toUpperCase()));
  const id = node('div', 'hero-fan-id');
  id.append(node('span', 'mono hero-fan-addr', shortAddr(row.address)));
  id.append(node('span', 'hero-fan-ago', `Last trade ${ago(row.lastTs, state.tapeEnd).toLowerCase()}`));
  top.append(id);
  card.append(top);

  const fig = node('div', 'hero-fan-fig');
  fig.append(signedPct(row.realizedPct));
  fig.append(node('span', 'hero-fan-fig-label', 'vs. matched'));
  card.append(fig);
  return card;
}

/** @param {BoardRow[]} top3 */
function renderHero(top3) {
  if (!heroEl) return;
  const decor = heroEl.querySelector('.hero-decor');
  if (!decor) return;
  const old = decor.querySelector('.hero-fan');
  if (old) old.remove();
  const fan = node('div', 'hero-fan');
  top3.forEach((row, i) => fan.append(heroCard(row, i)));
  decor.append(fan);
}

/** @param {BoardRow} row */
function buildCard(row) {
  const card = node('div', 'ct-card');

  const openBtn = /** @type {HTMLButtonElement} */ (node('button', 'ct-card-open'));
  openBtn.type = 'button';
  openBtn.setAttribute('aria-label', `Open profile for ${shortAddr(row.address)}`);
  openBtn.onclick = () => openProfile(row.address, openBtn);
  card.append(openBtn);

  const head = node('div', 'ct-card-head');
  head.append(node('span', `medal${row.rank <= 3 ? ` medal--${row.rank}` : ''}`, String(row.rank)));
  head.append(node('span', 'avatar mono', row.address.slice(2, 4).toUpperCase()));

  const idCol = node('div', 'ct-card-id');
  const addrLine = node('span', 'mono ct-card-addr');
  addrLine.append(document.createTextNode(shortAddr(row.address)));
  addrLine.append(copyButton(row.address, 'address'));
  idCol.append(addrLine);
  // Tiles only, overlapped, never the full token() chip (tile + ticker text) — this slot is
  // ~134px wide and a ticker per token is exactly what ran the header past the card's edge.
  // The full ticker belongs in the profile this card opens, not repeated here three times.
  const tokRow = node('div', 'ct-tokens');
  const shownTokens = row.tokens.slice(0, 3);
  shownTokens.forEach((sym, i) => {
    const tile = assetTile(sym, state.tokenKind.get(sym) ?? 'stock', 'ct-token-tile');
    if (i > 0) tile.style.marginLeft = '-7px';
    tokRow.append(tile);
  });
  if (row.tokens.length > shownTokens.length) {
    tokRow.append(node('span', 'ct-more', `+${row.tokens.length - shownTokens.length}`));
  }
  idCol.append(tokRow);
  head.append(idCol);

  head.append(node('span', 'spacer'));
  const agoChip = node('span', 'ct-ago mono');
  agoChip.append(icon(11, ICONS.clock));
  agoChip.append(document.createTextNode(ago(row.lastTs, state.tapeEnd)));
  head.append(agoChip);
  card.append(head);

  const body = node('div', 'ct-card-body');
  const stats = node('div', 'ct-card-stats');
  const pnlStat = node('div', 'ct-stat');
  pnlStat.append(signed(row.realized, 'ct-stat-value', compact));
  pnlStat.append(node('span', 'ct-stat-label', 'Realized PnL'));
  stats.append(pnlStat);
  const volStat = node('div', 'ct-stat');
  volStat.append(node('span', 'ct-stat-value mono', compact(row.matchedVolume)));
  volStat.append(node('span', 'ct-stat-label', 'Matched volume'));
  stats.append(volStat);
  body.append(stats);
  body.append(sparkline(row.series, { width: 200, height: 88 }));
  card.append(body);

  const foot = node('div', 'ct-card-foot');
  foot.append(chanceRow(row));
  // The copy score the frame put here has no definition and no data — see the file header.
  // The slot stays, because the feature is coming and the gap should be visible, and it says
  // what it needs rather than showing a number.
  const act = node('div', 'ct-card-foot-act');
  act.append(unwired('copyScore', { compact: true }));
  const copyBtn = /** @type {HTMLButtonElement} */ (node('button', 'btn-copy', 'Set up copy'));
  copyBtn.type = 'button';
  copyBtn.setAttribute('aria-label', `Set up copying ${shortAddr(row.address)}`);
  copyBtn.onclick = () => openSetup(row.address);
  act.append(copyBtn);
  foot.append(act);
  card.append(foot);

  return card;
}

function renderGrid() {
  const list = visibleRows(state.rows);
  countEl.textContent = `${list.length} trader${list.length === 1 ? '' : 's'}`;
  gridEl.replaceChildren();
  if (list.length === 0) {
    gridEl.append(node('div', 'ct-empty', state.query
      ? `No trader address matches “${state.query}”.`
      : 'No traders in this universe yet.'));
    moreBtn.hidden = true;
    return;
  }
  const shown = list.slice(0, state.visible);
  for (const row of shown) gridEl.append(buildCard(row));

  const remaining = list.length - shown.length;
  moreBtn.hidden = remaining <= 0;
  moreBtn.textContent = `Show ${Math.min(remaining, PAGE_SIZE)} more`;

  if (!state.heroDone && state.rows.length) {
    // The hero strip is a fixed first impression, not another view of the filtered grid — it
    // is set once, from the unfiltered/unsearched board, and never reshuffled by a later sort
    // or search so it does not visually jump while someone is refining the grid below it.
    state.heroDone = true;
    renderHero(state.rows.slice().sort(SORTS[0].cmp).slice(0, 3));
  }
}

function renderSort() {
  const sort = SORTS.find((s) => s.id === state.sortId) ?? SORTS[0];
  sortBtn.replaceChildren(document.createTextNode(sort.label), icon(14, ICONS.sort));
}

function renderTabs() {
  tabsEl.replaceChildren();
  for (const u of state.universes) {
    const btn = /** @type {HTMLButtonElement} */ (node('button', undefined, u.label));
    btn.type = 'button';
    const on = u.id === state.universe;
    btn.setAttribute('aria-pressed', String(on));
    btn.onclick = () => { if (state.universe !== u.id) { state.universe = u.id; loadBoard(); } };
    tabsEl.append(btn);
  }
}

function renderSeg() {
  segEl.replaceChildren();
  for (const w of state.windows) {
    const btn = /** @type {HTMLButtonElement} */ (node('button', undefined, w.label));
    btn.type = 'button';
    btn.setAttribute('aria-label', `Show the ${w.label} window`);
    const on = w.id === state.window;
    btn.setAttribute('aria-pressed', String(on));
    btn.onclick = () => { if (state.window !== w.id) { state.window = w.id; loadBoard(); } };
    segEl.append(btn);
  }
}

/**
 * Refetches the board for the current universe and window.
 *
 * BOTH ARE PASSED TO board(), never applied as a client-side filter over an 'all' fetch. As
 * lib/data.js's own comment says: once SOURCE is 'api' the same address's realized figure is
 * refolded PER SCOPE, so filtering an 'all' result after the fact would show the wrong number
 * for anyone who trades both universes. The mock happens to answer the same rows for every
 * window — there is one folded tape, not three — but wiring it this way costs nothing today
 * and is exactly correct the day SOURCE flips.
 */
async function loadBoard() {
  renderTabs();
  renderSeg();
  let res;
  try {
    res = await board({ universe: state.universe, window: state.window });
  } catch {
    // A dropped request reads as an empty board rather than a stuck grid — same reasoning as
    // the search palette and the trader profile: an admitted gap beats a spinner with nothing
    // behind it.
    res = { rows: [], tapeEnd: state.tapeEnd };
  }
  state.rows = res.rows;
  state.tapeEnd = res.tapeEnd;
  state.visible = PAGE_SIZE;
  renderGrid();
}

/**
 * chrome.js declares its `onSearch` hook with a plain `string` kind, so this takes one too and
 * narrows on the comparison rather than making the mount site cast.
 * @param {string} kind @param {string} id
 */
function onSearchPick(kind, id) {
  if (kind === 'trader') openProfile(id);
  else location.href = `/asset?symbol=${encodeURIComponent(id.toUpperCase())}`;
}

async function init() {
  mountChrome(el('chrome'), { current: 'copy', onSearch: onSearchPick });

  const main = el('copy-main');
  if (!main) return;
  main.replaceChildren();

  // ── hero ──────────────────────────────────────────────────────────────────────────────
  heroEl = node('section', 'hero');
  const heroText = node('div', 'hero-text');
  const h1 = node('h1');
  // WHAT THIS HEADLINE USED TO SAY. "Your portfolio, on autopilot." over "Every trade they
  // make is copied to your wallet in real time" — a description of a product that does not
  // exist. Nothing here places, copies or simulates a trade; execution is being built. The
  // page is honest about what it is: the same ranking, laid out for picking someone to
  // follow, with the copy flow visible and stopped at the point it would need a backend.
  h1.append(document.createTextNode('Pick a trader to '), node('em', undefined, 'follow.'));
  heroText.append(h1);
  heroText.append(node('p', undefined,
    'Every wallet on Robinhood Chain that closed a round-trip, with what it realized and '
    + 'whether that record is distinguishable from chance. Copying is not live yet: you can '
    + 'set one up and see exactly what it would send, and nothing is placed.'));
  heroEl.append(heroText);
  const decor = node('div', 'hero-decor');
  heroEl.append(decor);
  main.append(heroEl);

  // ── controls ──────────────────────────────────────────────────────────────────────────
  const controls = node('section', 'ct-controls');
  tabsEl = node('div', 'tabs');
  controls.append(tabsEl);
  const right = node('div', 'ct-controls-right');

  sortBtn = /** @type {HTMLButtonElement} */ (node('button', 'chip'));
  sortBtn.type = 'button';
  sortBtn.onclick = () => {
    const i = SORTS.findIndex((s) => s.id === state.sortId);
    state.sortId = SORTS[(i + 1) % SORTS.length].id;
    renderSort();
    renderGrid();
  };
  right.append(sortBtn);

  segEl = node('div', 'seg');
  right.append(segEl);

  const searchWrap = node('label', 'copy-search');
  const srLabel = node('span', 'sr-only', 'Search traders by address');
  searchWrap.append(srLabel);
  searchWrap.append(icon(15, ICONS.search));
  const searchInput = /** @type {HTMLInputElement} */ (node('input'));
  searchInput.type = 'search';
  searchInput.placeholder = 'Search by address';
  searchInput.setAttribute('aria-label', 'Search traders by address');
  searchInput.oninput = () => {
    state.query = searchInput.value;
    state.visible = PAGE_SIZE;
    renderGrid();
  };
  searchWrap.append(searchInput);
  right.append(searchWrap);
  controls.append(right);
  main.append(controls);

  // ── grid ──────────────────────────────────────────────────────────────────────────────
  const gridSection = node('section', 'ct-grid-section');
  const gridHead = node('div', 'ct-grid-head');
  countEl = node('span', 'ct-count');
  gridHead.append(countEl);
  gridSection.append(gridHead);
  gridEl = node('div', 'ct-grid');
  gridSection.append(gridEl);
  moreBtn = /** @type {HTMLButtonElement} */ (node('button', 'btn ct-showmore'));
  moreBtn.type = 'button';
  moreBtn.onclick = () => { state.visible += PAGE_SIZE; renderGrid(); };
  gridSection.append(moreBtn);
  main.append(gridSection);

  // ── data ──────────────────────────────────────────────────────────────────────────────
  let m;
  try {
    m = await meta();
  } catch {
    m = { universes: state.universes, windows: state.windows, sample: false };
  }
  state.universes = m.universes ?? state.universes;
  state.windows = m.windows ?? state.windows;
  state.window = state.windows.find((w) => w.id === '7d') ? '7d' : state.windows[0]?.id ?? state.window;
  renderSort();
  renderTabs();
  renderSeg();
  mountFoot(el('foot'), m);

  try {
    const list = await assets();
    for (const a of list) state.tokenKind.set(a.symbol, a.kind);
  } catch {
    // The token chips fall back to the "stock" pastel for every symbol, which is a cosmetic
    // miss, not a broken page — nothing on this grid depends on knowing an asset's kind.
  }

  await loadBoard();
}

init();
