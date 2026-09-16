/**
 * Traders: the card grid, and whether each record means anything.
 *
 * This is the page the reference calls Copytrading, in the reference's layout — hero,
 * preset tabs, filter row, card grid, sparkline per card, a bar across the bottom of each
 * card. What it is not is a funnel, because there is nothing here to funnel into: no
 * execution, no delegated signing, nothing to copy a trade into.
 *
 * WHAT THE BOTTOM BAR BECAME. The reference puts a 0-100 Copy Score and a Copytrade
 * button there. We have neither and will not fake either. The slot holds the one question
 * a copy button is a proxy for — is this record distinguishable from luck — answered by a
 * published criterion in lib/evidence.js and drawn as the observed win rate against the
 * band a coin-flipper of the same size lands in. The button opens the trades, which is the
 * only action this site can honestly offer.
 *
 * MAGNITUDES ARE SHOWN AS THEY ARE. The best address here closed $1,634 over seven days.
 * That number is not dressed up, and the caveat says what the window and the universe are.
 */

import { openDetail } from './lib/detail.js';
import { sparkline } from './lib/spark.js';
import { setTokenLogos, tokenCell } from './lib/token.js';
import { copyButton } from './lib/copy.js';
import { chanceBand, coverage, CRITERION } from './lib/evidence.js';
import { mountWallet } from './lib/wallet-ui.js';

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
/** @param {string} a */
const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Signed money carrying the sign three ways: glyph, sign character, colour.
 * @param {number} n @param {string} [cls]
 */
function signedMoney(n, cls) {
  const s = node('strong', `${n >= 0 ? 'up' : 'down'}${cls ? ` ${cls}` : ''}`);
  s.append(node('span', 'mark', n >= 0 ? '▲' : '▼'));
  s.append(document.createTextNode(`${n >= 0 ? '+' : '−'}${money(Math.abs(n))}`));
  return s;
}
/** @param {number} p */
function signedPct(p) {
  const s = node('strong', p >= 0 ? 'up' : 'down');
  s.append(node('span', 'mark', p >= 0 ? '▲' : '▼'));
  s.append(document.createTextNode(`${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(2)}%`));
  return s;
}

/**
 * Elapsed time, measured from the END OF THE TAPE rather than from now.
 * The data is a fixed historical window; against a wall clock every card would read the
 * same number of months and say nothing about which trader acted last.
 * @param {number|null} ts @param {number} anchor
 */
function ago(ts, anchor) {
  if (!ts) return '—';
  const s = Math.max(0, anchor - ts);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}M AGO`;
  if (s < 86400) return `${Math.round(s / 3600)}H AGO`;
  return `${Math.round(s / 86400)}D AGO`;
}

/** How far outside the coin-flip band, in standard errors. Orders "strength of evidence". */
const zOf = (/** @type {any} */ r) => (r.round_trips
  ? ((r.wins / r.round_trips) - 0.5) * 2 * Math.sqrt(r.round_trips) : 0);

const PRESETS = [
  { id: 'top', label: 'Top 100', sort: 'realized', where: () => true },
  { id: 'evidence', label: 'Beyond chance', sort: 'evidence',
    where: (/** @type {any} */ r) => chanceBand(r.wins, r.round_trips).verdict === 'above' },
  { id: 'active', label: 'Most active', sort: 'round_trips', where: () => true },
  { id: 'efficient', label: 'Best on volume', sort: 'efficiency',
    where: (/** @type {any} */ r) => r.matched_volume > 0 },
  { id: 'recent', label: 'Traded last', sort: 'last_ts', where: () => true },
];

const PAGE = 24;
const state = {
  /** @type {any} */ data: null,
  preset: 'top',
  sort: 'realized',
  unit: 'abs',
  view: 'grid',
  limit: PAGE,
  query: '',
  filters: { realized: -1e12, trips: 1, win: 0, evidence: 'any' },
};

/** @param {any} r */
function sortKey(r) {
  switch (state.sort) {
    case 'evidence': return zOf(r);
    case 'win_rate': return r.win_rate;
    case 'round_trips': return r.round_trips;
    case 'matched_volume': return r.matched_volume;
    case 'efficiency': return r.matched_volume ? r.realized / r.matched_volume : -Infinity;
    case 'last_ts': return r.last_ts ?? 0;
    default: return r.realized;
  }
}

function visible() {
  const preset = PRESETS.find((p) => p.id === state.preset) ?? PRESETS[0];
  const f = state.filters;
  return state.data.rows
    .filter((/** @type {any} */ r) => preset.where(r))
    .filter((/** @type {any} */ r) => r.realized >= f.realized
      && r.round_trips >= f.trips && r.win_rate >= f.win)
    .filter((/** @type {any} */ r) => {
      if (f.evidence === 'any') return true;
      const b = chanceBand(r.wins, r.round_trips);
      return f.evidence === 'above' ? b.verdict === 'above' : b.decisive;
    })
    .filter((/** @type {any} */ r) => !state.query || r.address.includes(state.query))
    .sort((/** @type {any} */ a, /** @type {any} */ b) => sortKey(b) - sortKey(a));
}

/**
 * The bar across the bottom of a card, where the reference puts Copy Score and Copytrade.
 * @param {any} r
 */
function evidenceBar(r) {
  const b = chanceBand(r.wins, r.round_trips);
  const bar = node('div', `tcard-bar v-${b.verdict}`);

  const left = node('div', 'ev');
  const head = node('div', 'ev-head');
  head.append(node('b', undefined, `${(b.rate * 100).toFixed(1)}%`));
  head.append(node('span', 'ev-of', 'win rate'));
  left.append(head);

  // Track: the shaded region is where a coin-flipper with this many closes lands.
  const track = node('div', 'ev-track');
  track.setAttribute('role', 'img');
  track.setAttribute('aria-label',
    `Win rate ${(b.rate * 100).toFixed(1)} percent over ${r.round_trips} closed round-trips. `
    + `Chance produces ${(b.lo * 100).toFixed(0)} to ${(b.hi * 100).toFixed(0)} percent. ${b.label}.`);
  const band = node('i', 'ev-band');
  band.style.left = `${b.lo * 100}%`;
  band.style.width = `${Math.max(0, (b.hi - b.lo) * 100)}%`;
  const mark = node('i', 'ev-mark');
  mark.style.left = `${b.rate * 100}%`;
  track.append(band, mark);
  left.append(track);

  const foot = node('div', 'ev-foot');
  foot.append(node('span', 'ev-label', b.label));
  foot.append(node('span', 'ev-n', `${r.round_trips} closed`));
  // A badge over 12% of someone's flow is not the claim a badge over 95% is.
  const cov = coverage(r.out_of_scope_volume, r.total_volume);
  const covered = node('span', 'ev-n', `${cov.toFixed(0)}% covered`);
  covered.title = `${cov.toFixed(1)}% of this address's selling had an on-chain buy behind `
    + 'it. The rest has no cost basis and is not scored.';
  foot.append(covered);
  left.append(foot);

  const cta = node('button', 'ev-cta', 'View trades');
  cta.type = 'button';
  cta.setAttribute('aria-label', `View trades for ${r.address}`);
  cta.onclick = (e) => { e.stopPropagation?.(); void openDetail(r.address, cta); };

  bar.append(left, cta);
  return bar;
}

/** @param {any} r @param {number} anchor */
function traderCard(r, anchor) {
  const card = node('article', 'tcard');
  card.tabIndex = 0;
  card.setAttribute('role', 'link');
  card.setAttribute('aria-label', `Open ${r.address}`);
  card.onclick = () => { void openDetail(r.address, card); };
  card.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void openDetail(r.address, card); }
  };

  const head = node('div', 'tcard-head');
  head.append(node('span', 'avatar', '◇'));
  const who = node('div', 'tcard-who');
  const line = node('div', 'tcard-addr');
  line.append(node('b', undefined, shortAddr(r.address)), copyButton(r.address));
  who.append(line);
  const toks = node('div', 'tcard-toks');
  for (const t of r.tokens) toks.append(tokenCell(t, 'chip'));
  if (r.token_count > r.tokens.length) {
    toks.append(node('span', 'chip', `+${r.token_count - r.tokens.length}`));
  }
  who.append(toks);
  head.append(who, node('span', 'tcard-ago', ago(r.last_ts, anchor)));
  card.append(head);

  const body = node('div', 'tcard-body');
  const figs = node('div', 'tcard-figs');
  figs.append(state.unit === 'abs' ? signedMoney(r.realized)
    : signedPct(r.matched_volume ? (r.realized / r.matched_volume) * 100 : 0));
  figs.append(node('span', 'tcard-label', 'Realized, round-trips only'));
  figs.append(node('strong', 'tcard-second', compact(r.matched_volume)));
  figs.append(node('span', 'tcard-label', 'Matched volume'));
  body.append(figs);
  const spark = node('div', 'tcard-spark');
  spark.append(sparkline(r.spark ?? [], { width: 240, height: 88 }));
  body.append(spark);
  card.append(body);

  card.append(evidenceBar(r));
  return card;
}

const COLUMNS = [
  { key: 'rank', label: '#' },
  { key: 'address', label: 'Trader' },
  { key: 'realized', label: 'Realized' },
  { key: 'matched_volume', label: 'Matched vol' },
  { key: 'win_rate', label: 'Win rate' },
  { key: 'evidence', label: 'Against chance' },
  { key: 'round_trips', label: 'Closed' },
];

/** @param {any[]} rows @param {number} anchor */
function renderList(rows, anchor) {
  const head = el('head');
  head.replaceChildren();
  for (const c of COLUMNS) {
    const th = node('th', undefined, c.label);
    th.scope = 'col';
    head.append(th);
  }
  const body = el('rows');
  body.replaceChildren();
  rows.forEach((r) => {
    const tr = node('tr');
    tr.tabIndex = 0;
    tr.setAttribute('role', 'link');
    tr.setAttribute('aria-label', `Open ${r.address}`);
    tr.onclick = () => { void openDetail(r.address, tr); };
    tr.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void openDetail(r.address, tr); }
    };
    tr.append(node('td', 'rank', String(r.rank)));
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
    tr.append(node('td', undefined, `${r.win_rate.toFixed(1)}%`));
    const b = chanceBand(r.wins, r.round_trips);
    tr.append(node('td', `v-text-${b.verdict}`, b.label));
    tr.append(node('td', undefined, String(r.round_trips)));
    body.append(tr);
  });
  el('listwrap').hidden = false;
  el('grid').hidden = true;
  void anchor;
}

function render() {
  const rows = visible();
  const anchor = state.data.to_ts;
  const page = rows.slice(0, state.limit);

  if (state.view === 'list') {
    renderList(page, anchor);
  } else {
    const grid = el('grid');
    grid.replaceChildren();
    for (const r of page) grid.append(traderCard(r, anchor));
    grid.hidden = false;
    el('listwrap').hidden = true;
  }
  el('empty').hidden = rows.length > 0;
  el('more').hidden = rows.length <= state.limit;
  el('more').textContent = `Show more (${Math.min(PAGE, rows.length - state.limit)} of `
    + `${(rows.length - state.limit).toLocaleString('en-US')} left)`;

  const deck = el('hero-deck');
  deck.replaceChildren();
  // Three or none. A stack of one is not a stack, it is a card that failed to render.
  deck.hidden = rows.length < 3;
  for (const r of (rows.length < 3 ? [] : rows.slice(0, 3))) {
    const mini = node('div', 'deckcard');
    mini.append(node('span', 'deck-addr', shortAddr(r.address)));
    mini.append(signedMoney(r.realized, 'deck-fig'));
    mini.append(sparkline(r.spark ?? [], { width: 200, height: 48 }));
    deck.append(mini);
  }
}

function renderPresets() {
  const bar = el('presets');
  bar.replaceChildren();
  for (const p of PRESETS) {
    const b = node('button', state.preset === p.id ? 'is-active' : undefined, p.label);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(state.preset === p.id));
    b.onclick = () => {
      state.preset = p.id;
      state.sort = p.sort;
      state.limit = PAGE;
      /** @type {HTMLSelectElement} */ (el('sort')).value =
        ['realized', 'evidence', 'win_rate', 'round_trips', 'matched_volume', 'last_ts']
          .includes(p.sort) ? p.sort : 'realized';
      renderPresets();
      render();
    };
    bar.append(b);
  }
}

/**
 * Scope stays above the ranking, but as one line rather than a wall.
 *
 * It used to be a five-line paragraph wedged between the filters and the cards, which is
 * where a reader is looking for content, so it was skipped exactly by the people it is
 * there for. The numbers that bound the ranking stay in the hero where scope is read
 * before rank; the method behind the evidence bar moves into a disclosure beside the
 * filter that uses it.
 */
function renderCaveat() {
  const c = state.data.coverage;
  const p = el('caveat');
  p.replaceChildren();
  p.append(node('b', undefined,
    `${c.addresses_qualifying.toLocaleString('en-US')} of `
    + `${c.addresses_seen.toLocaleString('en-US')} addresses `));
  p.append(document.createTextNode(
    `closed a round-trip over ${c.window_label} across ${c.universe}. `
    + 'The rest are out of scope, not estimated.'));
  el('criterion').textContent = CRITERION;
}

function renderFootnote() {
  const f = el('footnote');
  f.replaceChildren();
  f.append(node('p', undefined,
    'Elapsed times are measured from the end of the tape, not from now, because the data '
    + 'is a fixed historical window.'));
  f.append(node('p', undefined,
    'There is no execution here and no trade is copied. The strongest record on this page '
    + `closed ${money(Math.max(...state.data.rows.map((/** @type {any} */ r) => r.realized)))} `
    + 'over the window.'));
}

/** @param {string} id @param {(v: string) => void} fn */
function onSelect(id, fn) {
  const s = /** @type {HTMLSelectElement} */ (el(id));
  s.onchange = () => { fn(s.value); state.limit = PAGE; render(); };
}

const index = await fetch('/data/leaderboard/index.json').then((r) => r.json());
setTokenLogos(await fetch('/data/tokens.json')
  .then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
const entry = index.windows.find((/** @type {any} */ w) => w.window === '7d') ?? index.windows.at(-1);
state.data = await fetch(`/data/leaderboard/${entry.file}`).then((r) => r.json());

renderPresets();
renderCaveat();
renderFootnote();
render();
mountWallet(el('wallet'));

onSelect('sort', (v) => { state.sort = v; });
onSelect('f-realized', (v) => { state.filters.realized = Number(v); });
onSelect('f-trips', (v) => { state.filters.trips = Number(v); });
onSelect('f-win', (v) => { state.filters.win = Number(v); });
onSelect('f-evidence', (v) => { state.filters.evidence = v; });

/**
 * Delegated so the buttons come from the markup and the handler does not have to be
 * rebound, matching how the leaderboard wires its own toggle.
 * @param {string} id @param {string} attr @param {(v: string) => void} set
 */
function toggle(id, attr, set) {
  el(id).addEventListener('click', (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest(`[${attr}]`);
    if (!b) return;
    set(/** @type {string} */ (b.getAttribute(attr)));
    for (const x of el(id).querySelectorAll(`[${attr}]`)) {
      x.setAttribute('aria-pressed', String(x === b));
    }
    render();
  });
}
toggle('unit', 'data-unit', (v) => { state.unit = v; });
toggle('view', 'data-view', (v) => { state.view = v; });
el('more').onclick = () => { state.limit += PAGE; render(); };

const search = /** @type {HTMLInputElement} */ (el('search'));
search.oninput = () => {
  const q = search.value.trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(q)) { void openDetail(q); return; }
  state.query = q;
  state.limit = PAGE;
  render();
};
