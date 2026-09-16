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
import { mountSearchShortcut, rankBadge, renderStatusBar, stackedChips } from './lib/chrome.js';

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

const CATEGORIES = [
  { id: 'all', label: 'All' }, { id: 'rwa', label: 'RWA' }, { id: 'pons', label: 'Pons' },
];
/** @type {{id: string | null, label: string}[]} */
const QUOTES = [
  { id: null, label: 'All' }, { id: 'USDG', label: 'USDG' }, { id: 'ETH', label: 'ETH' },
];

const PAGE = 24;
const state = {
  /** @type {any} */ index: null,
  /** @type {any} */ manifest: null,
  /** @type {any} */ data: null,
  cat: 'all',
  /** @type {string | null} */ quote: null,
  // Set from the manifest at startup, not here. A tape younger than seven days publishes
  // only the 24h window, and a page that asks for '7d' regardless finds no view and shows
  // an empty grid over a store that has data in it. index.js already reads it this way.
  window: '',
  sort: 'realized',
  unit: 'abs',
  view: 'grid',
  limit: PAGE,
  query: '',
  filters: { realized: -1e12, trips: 1, win: 0, evidence: 'any' },
};

/**
 * Category and quote pick a SCOPE, and a scope is a different build — the matching is
 * refolded on that scope's trades. Filtering the rows instead would leave a Pons table
 * whose numbers still contained RWA profit, because most of the top trades both.
 */
function scopeId() {
  const parts = [];
  if (state.cat !== 'all' || state.quote) parts.push(state.cat);
  if (state.quote) parts.push(state.quote.toLowerCase());
  return parts.length ? parts.join('-') : 'all';
}

/** @param {string} id @param {string} win */
const viewFor = (id, win) => state.index.views.find(
  (/** @type {any} */ v) => v.scope === id && v.window === win);

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
  const f = state.filters;
  return state.data.rows
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
  head.append(node('span', 'ev-of', 'win'));
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
  left.append(foot);

  const cta = node('button', 'ev-cta', 'Trades');
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
  who.append(stackedChips(r.tokens, r.token_count,
    (t) => /** @type {any} */ (tokenCell(t, 'chip chip--stack'))));
  head.append(who, node('span', 'tcard-ago', ago(r.last_ts, anchor)));
  card.append(head);

  const body = node('div', 'tcard-body');
  const figs = node('div', 'tcard-figs');
  figs.append(state.unit === 'abs' ? signedMoney(r.realized)
    : signedPct(r.matched_volume ? (r.realized / r.matched_volume) * 100 : 0));
  figs.append(node('span', 'tcard-label', 'Realized, round-trips only'));
  figs.append(node('strong', 'tcard-second', compact(r.matched_volume)));
  figs.append(node('span', 'tcard-label', 'Matched volume'));
  // The record behind the badge, in the column that has room for words rather than
  // crammed into a 46px bar where "Beyond chance" truncated to "Beyond".
  const cov = coverage(r.out_of_scope_volume, r.total_volume);
  const band = chanceBand(r.wins, r.round_trips);
  figs.append(node('div', `tcard-verdict v-${band.verdict}`, band.label));
  // Short enough to fit a 310px card without ellipsis; the full wording is in the title.
  const rec = node('div', 'tcard-record',
    `${r.round_trips} closed · ${cov.toFixed(0)}% covered`);
  rec.title = `${r.round_trips} completed round-trips. ${cov.toFixed(1)}% of this address's `
    + 'selling had an on-chain buy behind it; the rest has no cost basis and is not scored.';
  figs.append(rec);
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
  (rows.length < 3 ? [] : rows.slice(0, 3)).forEach((/** @type {any} */ r, /** @type {number} */ i) => {
    const mini = node('div', 'deckcard');
    const head = node('div', 'deck-head');
    head.append(node('span', 'deck-addr', shortAddr(r.address)));
    head.append(/** @type {any} */ (rankBadge(i + 1)));
    mini.append(head);
    mini.append(signedMoney(r.realized, 'deck-fig'));
    mini.append(sparkline(r.spark ?? [], { width: 200, height: 48 }));
    deck.append(mini);
  });
}

/**
 * @param {string} id @param {{id: any, label: string}[]} items
 * @param {() => any} get @param {(v: any) => void} set
 */
function renderTabs(id, items, get, set) {
  const bar = el(id);
  bar.replaceChildren();
  for (const it of items) {
    const active = get() === it.id;
    const b = node('button', undefined, it.label);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(active));
    // A scope with no trades is not offered rather than offered empty.
    const ok = id !== 'categories' || viewFor(it.id === 'all' && !state.quote ? 'all'
      : [it.id === 'all' ? null : it.id, state.quote ? state.quote.toLowerCase() : null]
        .filter(Boolean).join('-'), state.window);
    if (!ok) b.disabled = true;
    b.onclick = () => { set(it.id); state.limit = PAGE; void load(); };
    bar.append(b);
  }
}

function renderControls() {
  renderTabs('categories', CATEGORIES, () => state.cat, (v) => { state.cat = v; });
  renderTabs('quotes', QUOTES, () => state.quote, (v) => { state.quote = v; });
  renderTabs('windows', state.index.windows.map((/** @type {any} */ w) => (
    { id: w.window, label: w.label })), () => state.window, (v) => { state.window = v; });
}

/**
 * The shape of the field, above the ranking.
 *
 * The top row is an outlier by two orders of magnitude and reads as the story. It is not:
 * half of everyone who closed a round-trip made under a dollar, and the top 1% took half
 * of everything won. The distribution says so before the table can imply otherwise.
 */
function renderDistribution() {
  const d = state.data.distribution;
  const host = el('dist');
  host.replaceChildren();
  /** @param {string} k @param {HTMLElement|string} v @param {string} [sub] */
  const stat = (k, v, sub) => {
    const b = node('div', 'dstat');
    b.append(node('span', 'dstat-k', k));
    const val = node('strong', typeof v === 'string' ? 'dstat-plain' : undefined);
    if (typeof v === 'string') val.textContent = v; else val.append(v);
    b.append(val);
    if (sub) b.append(node('span', 'dstat-sub', sub));
    return b;
  };
  const p = d.percentiles;
  host.append(stat('Best', signedMoney(p['100']), `of ${d.qualifying.toLocaleString('en-US')} who closed a trade`));
  host.append(stat('Median', signedMoney(p['50']), 'half of them made less'));
  host.append(stat('In profit', `${d.in_profit_pct.toFixed(1)}%`,
    `${d.at_a_loss.toLocaleString('en-US')} lost money`));
  host.append(stat('Top 1% took', `${(d.top1pct_share * 100).toFixed(0)}%`,
    `of ${money(d.total_won)} won`));
  host.append(stat('Lost', signedMoney(d.total_lost), 'across the field'));
}

/**
 * Scope before ranking, in ONE line.
 *
 * This was eleven lines of body text above the fold, which is eleven lines nobody reads
 * and a card grid pushed off the screen. The reference gives its subtitle one line. So the
 * numbers that bound the ranking stay visible — how many qualified, out of how many, over
 * what window — and the method that explains them moves behind the disclosure beside the
 * filters, where someone who wants it will look for it.
 */
function renderCaveat() {
  const c = state.data.coverage;
  const d = state.data.distribution;
  const sub = el('hero-sub');
  sub.replaceChildren();
  sub.append(node('b', undefined,
    `${c.addresses_qualifying.toLocaleString('en-US')} of `
    + `${c.addresses_seen.toLocaleString('en-US')} addresses`));
  sub.append(document.createTextNode(
    ` closed a round-trip over ${c.window_label}; half of them made under `
    + `${money(Math.abs(d.percentiles['50']))}. `));
  const more = node('a', 'sub-link', 'How this is measured');
  more.setAttribute('href', '#measured');
  more.onclick = (e) => {
    e.preventDefault?.();
    const box = /** @type {any} */ (el('measured'));
    box.open = true;
    box.setAttribute('open', 'true');
    box.scrollIntoView?.({ block: 'center' });
  };
  sub.append(more);

  // Everything that used to sit above the fold, behind the disclosure.
  const full = el('criterion');
  full.replaceChildren();
  /** @param {string} text @param {string} [cls] */
  const para = (text, cls) => full.append(node('p', cls, text));
  para(`Ranked over ${c.universe}. ${c.note}`);
  para(c.usd_note);
  para(c.scope_note);
  para(CRITERION);
  if (c.magnitude_note) {
    // A high success rate on a small-magnitude universe reads as safety. It is not.
    para(c.magnitude_note, 'warn-note');
  }
  para(c.truncation_note);
}

function renderFootnote() {
  const f = el('footnote');
  f.replaceChildren();
  f.append(node('p', undefined,
    'Elapsed times are measured from the end of the tape, not from now, because the data '
    + 'is a fixed historical window.'));
  // Name the build. A proxied dev session and a deployed one look identical otherwise,
  // and a bug report has to be able to say which one it saw.
  if (state.manifest?.build) {
    const b = node('p', 'build-line');
    b.append(document.createTextNode('Build '));
    b.append(node('code', undefined, state.manifest.build));
    b.append(document.createTextNode(
      ` · ${Number(state.manifest.addresses).toLocaleString('en-US')} addresses stored`));
    f.append(b);
  }
  f.append(node('p', undefined,
    'There is no execution here and no trade is copied. Category and quote refold the '
    + 'matching on that scope\'s trades rather than filtering rows, because most of the '
    + 'top of this table trades both universes.'));
}

/** @param {string} id @param {(v: string) => void} fn */
function onSelect(id, fn) {
  const s = /** @type {HTMLSelectElement} */ (el(id));
  s.onchange = () => { fn(s.value); state.limit = PAGE; render(); };
}

/** Fetch the current scope's build and redraw everything that depends on it. */
async function load() {
  const view = viewFor(scopeId(), state.window) ?? viewFor('all', state.window);
  state.data = await fetch(`/api/leaderboard/${view.scope}/${view.window}`)
    .then((r) => r.json());
  renderControls();
  renderCaveat();
  renderDistribution();
  renderFootnote();
  render();
}

state.manifest = await fetch('/api/manifest').then((r) => r.json()).catch(() => ({}));
state.index = await fetch('/api/leaderboard/index').then((r) => r.json()).catch(() => null);
// The widest window this build actually has. windows[] carries only the ones that were
// built, widest last.
state.window = state.index?.windows?.at(-1)?.window ?? '7d';

/**
 * Before the first build exists there is nothing to rank, and that is a state rather than
 * an error. A fresh deploy serves this until a cycle lands, instead of a page that throws
 * on an index it has not got.
 */
if (!state.index?.views?.length) {
  el('hero-sub').textContent = state.manifest?.detail
    || 'No build yet. The first cycle will fill this.';
  for (const id of ['dist', 'grid', 'listwrap', 'more']) el(id).hidden = true;
  el('caveat').textContent = '';
  el('empty').hidden = false;
  el('empty').textContent = 'Nothing has been built yet. This page fills itself on the '
    + 'next cycle; nothing here is cached or stale.';
  mountWallet(el('wallet'));
} else {
setTokenLogos(await fetch('/api/leaderboard/tokens/tokens')
  .then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
await load();
mountWallet(el('wallet'));
}
mountSearchShortcut();
renderStatusBar(state.manifest);

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
