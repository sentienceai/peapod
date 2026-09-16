/**
 * The leaderboard.
 *
 * Ranks realized PnL on completed round-trips: bought and sold on-chain, matched FIFO.
 * It ranks TRADING, not holdings — an address that bridged in a position and sold it made
 * no trading decision this can score, and scoring it would reward provenance.
 *
 * The coverage caveat renders above every control, because the share of addresses this
 * covers is part of reading the ranking, not a footnote to it.
 */

import { sparkline } from './lib/spark.js';
import { openDetail } from './lib/detail.js';
import { setTokenLogos, tokenCell } from './lib/token.js';
import { copyButton } from './lib/copy.js';

/** @param {string} id */
const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag @param {string} [cls] @param {string} [text]
 * @returns {HTMLElementTagNameMap[K]}
 */
function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const usd0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** @param {number} n */
const money = (n) => `$${Math.abs(n) < 10000 ? usd2.format(n) : usd0.format(Math.round(n))}`;
/** @param {number} n */
const compact = (n) => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M`
  : Math.abs(n) >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : money(n));

/**
 * Signed money, carrying the sign THREE ways: a direction glyph, an explicit sign
 * character, and colour. Colour plus a minus sign is two channels for most readers but
 * not for someone colourblind scanning a dense column quickly, and a minus sign is only a
 * few pixels wide.
 * @param {number} n
 */
function signedMoney(n) {
  const span = node('span', n >= 0 ? 'up' : 'down');
  span.append(node('span', 'mark', n >= 0 ? '▲' : '▼'));
  span.append(document.createTextNode(`${n >= 0 ? '+' : '−'}${money(Math.abs(n))}`));
  return span;
}

/** @param {number} n */
function signedPct(n) {
  const span = node('span', n >= 0 ? 'up' : 'down');
  span.append(node('span', 'mark', n >= 0 ? '▲' : '▼'));
  span.append(document.createTextNode(`${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}%`));
  return span;
}

/** @param {string} a */
const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const index = await fetch('/data/leaderboard/index.json').then((r) => r.json());
// Logos are decoration over data that already renders; a failed map leaves every
// token on its initials tile rather than failing the page.
setTokenLogos(await fetch('/data/tokens.json')
  .then((r) => (r.ok ? r.json() : {})).catch(() => ({})));

const state = {
  window: index.windows.at(-1)?.window ?? 'all',
  category: 'rwa',
  quote: 'usdg',
  unit: 'abs',
  sort: 'realized',
  dir: -1,
  query: '',
  minTrips: 1,
  minWin: 0,
  /** @type {any} */ data: null,
};

/* ------------------------------------------------------------------ tabs */

function buildTabs() {
  const cats = el('categories');
  cats.replaceChildren();
  for (const c of index.categories) {
    const b = node('button', undefined, c.label);
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(c.id === state.category));
    if (!c.available) {
      b.disabled = true;
      b.title = c.note;
    } else {
      b.onclick = () => { state.category = c.id; void load(); };
    }
    cats.append(b);
  }
  const quotes = el('quotes');
  quotes.replaceChildren();
  for (const q of index.quotes) {
    const b = node('button', undefined, q.label);
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(q.id === state.quote));
    if (!q.available) { b.disabled = true; b.title = q.note ?? ''; }
    quotes.append(b);
  }
  const wins = el('windows');
  wins.replaceChildren();
  /** @type {Record<string,string>} */
  const labels = { '1d': '24H', '7d': '7D', '30d': '30D', all: 'All' };
  for (const w of index.windows) {
    const b = node('button', undefined, labels[w.window] ?? w.window.toUpperCase());
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(w.window === state.window));
    b.onclick = () => { state.window = w.window; void load(); };
    wins.append(b);
  }
}

/* -------------------------------------------------------------- rendering */

function renderCaveat() {
  const c = state.data.coverage;
  const p = el('caveat');
  p.replaceChildren();
  const n = (/** @type {number} */ x) => x.toLocaleString('en-US');

  p.append(document.createTextNode('Realized PnL on completed round-trips only: bought and sold on-chain, matched first-in-first-out. Across '));
  p.append(node('b', undefined, c.window_label));
  p.append(document.createTextNode(' of '));
  p.append(node('b', undefined, c.universe));
  p.append(document.createTextNode(', '));
  p.append(node('b', undefined, `${n(c.addresses_qualifying)} of ${n(c.addresses_seen)} addresses qualify`));
  p.append(document.createTextNode(` (${c.qualifying_pct.toFixed(1)}%) and `));
  p.append(node('b', undefined, `${c.matched_flow_pct.toFixed(1)}% of volume is matched round-trip flow`));
  p.append(document.createTextNode('. '));
  // The ranking is truncated. Saying so is the difference between a top-N and a claim to
  // be the whole set.
  p.append(node('b', undefined, `Showing the top ${n(c.rows_shown)}`));
  p.append(document.createTextNode('. '));
  p.append(document.createTextNode(c.universe_note + ' Holdings acquired any other way — bridged, issued, transferred in — are out of scope, not estimated.'));
}

const COLUMNS = [
  { key: 'rank', label: 'Rank', sortable: false },
  { key: 'address', label: 'Trader', sortable: false },
  { key: 'realized', label: 'Realized', sortable: true },
  { key: 'matched_volume', label: 'Matched vol', sortable: true },
  { key: 'win_rate', label: 'Win rate', sortable: true },
  { key: 'round_trips', label: 'Round-trips', sortable: true },
  { key: 'tokens', label: 'Tokens', sortable: false },
];

function renderHead() {
  const tr = el('head');
  tr.replaceChildren();
  for (const col of COLUMNS) {
    const th = node('th');
    th.scope = 'col';
    if (col.key === 'win_rate') th.title = 'Share of matched round-trips that closed at a profit';
    if (col.sortable) {
      const b = node('button', undefined, col.label);
      b.append(node('span', undefined, state.sort === col.key ? (state.dir < 0 ? ' ▾' : ' ▴') : ' ⇅'));
      b.setAttribute('aria-hidden', 'false');
      b.onclick = () => {
        if (state.sort === col.key) state.dir = -state.dir;
        else { state.sort = col.key; state.dir = -1; }
        render();
      };
      th.append(b);
    } else {
      th.textContent = col.label;
    }
    tr.append(th);
  }
}

/** @param {any} r */
function rateClass(r) {
  return r.win_rate >= 60 ? 'rate-high' : r.win_rate >= 45 ? 'rate-mid' : 'rate-low';
}

/** @param {any} r @param {number} place */
function podiumCard(r, place) {
  const card = node('div', `pcard${place === 1 ? ' pcard--first' : ''}`);
  card.tabIndex = 0;
  card.setAttribute('role', 'link');
  card.setAttribute('aria-label', `Open ${r.address}`);
  card.style.cursor = 'pointer';
  card.onclick = () => { void openDetail(r.address, card); };
  card.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void openDetail(r.address, card); }
  };
  const top = node('div', 'pcard-top');
  const who = node('div', 'pcard-addr');
  who.append(node('span', 'avatar', '◇'), document.createTextNode(shortAddr(r.address)),
    copyButton(r.address));
  top.append(who, node('span', 'rankbadge', `#${place}`));
  card.append(top);
  card.append(sparkline(r.spark, { width: 380, height: 64 }));
  const fig = node('div', 'pcard-figure');
  const strong = node('strong');
  strong.append(state.unit === 'abs' ? signedMoney(r.realized)
    : signedPct(r.matched_volume ? (r.realized / r.matched_volume) * 100 : 0));
  fig.append(strong, node('span', undefined, 'Realized, round-trips only'));
  card.append(fig);
  card.append(node('div', 'pcard-sub',
    `${money(r.matched_volume)} matched · ${r.round_trips} round-trips · ${r.win_rate.toFixed(0)}% win`));
  return card;
}

function render() {
  const rows = state.data.rows
    .filter((/** @type {any} */ r) => r.round_trips >= state.minTrips && r.win_rate >= state.minWin)
    .filter((/** @type {any} */ r) => !state.query || r.address.includes(state.query));
  const sorted = [...rows].sort((a, b) => (a[state.sort] - b[state.sort]) * state.dir);

  const podium = el('podium');
  podium.replaceChildren();
  sorted.slice(0, 3).forEach((r, i) => podium.append(podiumCard(r, i + 1)));

  const body = el('rows');
  body.replaceChildren();
  sorted.slice(3).forEach((r, i) => {
    const tr = node('tr');
    tr.tabIndex = 0;
    tr.setAttribute('role', 'link');
    tr.setAttribute('aria-label', `Open ${r.address}`);
    tr.style.cursor = 'pointer';
    tr.onclick = () => { void openDetail(r.address, tr); };
    tr.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void openDetail(r.address, tr); }
    };
    tr.append(node('td', 'rank', String(i + 4)));
    const who = node('td');
    const wrap = node('div', 'who');
    wrap.append(node('span', 'avatar', '◇'), node('span', 'addr', shortAddr(r.address)),
      copyButton(r.address));
    who.append(wrap);
    tr.append(who);

    const pnl = node('td');
    pnl.append(state.unit === 'abs' ? signedMoney(r.realized)
      : signedPct(r.matched_volume ? (r.realized / r.matched_volume) * 100 : 0));
    tr.append(pnl);

    tr.append(node('td', undefined, compact(r.matched_volume)));
    tr.append(node('td', rateClass(r), `${r.win_rate.toFixed(1)}%`));
    tr.append(node('td', undefined, String(r.round_trips)));

    const toks = node('td');
    const chips = node('span', 'chips');
    for (const t of r.tokens) chips.append(tokenCell(t, 'chip'));
    if (r.token_count > r.tokens.length) chips.append(node('span', 'chip', `+${r.token_count - r.tokens.length}`));
    toks.append(chips);
    tr.append(toks);
    body.append(tr);
  });

  el('empty').hidden = sorted.length > 0;
}

function renderFootnote() {
  const p = state.data.provenance;
  const f = el('footnote');
  f.replaceChildren();
  f.append(node('p', undefined,
    `Window: ${state.data.hours} hours of tape ending ${p.anchors.swap_tape_end.iso}. `
    + `${state.data.coverage.addresses_seen.toLocaleString()} addresses traded; `
    + `${state.data.coverage.addresses_qualifying.toLocaleString()} completed a round-trip.`));
  f.append(node('p', undefined, p.subsidy.note));
  f.append(node('p', undefined,
    'Win rate is the share of matched round-trips that closed at a profit — not a share of '
    + 'closed positions, which do not exist on a spot AMM.'));
}

/* ------------------------------------------------------------------- boot */

async function load() {
  const entry = index.windows.find((/** @type {any} */ w) => w.window === state.window)
    ?? index.windows.at(-1);
  state.data = await fetch(`/data/leaderboard/${entry.file}`).then((r) => r.json());
  buildTabs();
  renderCaveat();
  renderHead();
  render();
  renderFootnote();
}

el('unit').addEventListener('click', (e) => {
  const b = /** @type {HTMLElement} */ (e.target).closest('[data-unit]');
  if (!b) return;
  state.unit = /** @type {string} */ (b.getAttribute('data-unit'));
  for (const x of el('unit').querySelectorAll('[data-unit]')) {
    x.setAttribute('aria-pressed', String(x === b));
  }
  render();
});
/**
 * Search resolves ANY address on the tape, not just the ranked rows on screen. Finding
 * yourself at rank 11,400 is the point of a search box; filtering the top 1,000 is not.
 * A full address opens its detail view directly; a fragment filters the visible rows.
 */
const FULL_ADDRESS = /^0x[0-9a-f]{40}$/;
el('search').addEventListener('input', (e) => {
  const raw = /** @type {HTMLInputElement} */ (e.target).value.trim().toLowerCase();
  state.query = raw;
  if (FULL_ADDRESS.test(raw)) {
    void openDetail(raw);
    return;
  }
  render();
});
el('min-trips').addEventListener('change', (e) => {
  state.minTrips = Number(/** @type {HTMLSelectElement} */ (e.target).value);
  render();
});
el('min-win').addEventListener('change', (e) => {
  state.minWin = Number(/** @type {HTMLSelectElement} */ (e.target).value);
  render();
});


await load();
