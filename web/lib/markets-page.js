/**
 * Markets: every token the tape traded in the window, from /api/assets.
 *
 * WHAT THIS REPLACES. "Markets" in the top bar pointed at /asset?symbol=TSLA — one asset,
 * chosen in the nav, with no way to see the rest. The asset list has existed since the
 * endpoints landed; this is the page that reads it.
 *
 * EVERY COLUMN IS MEASURED, and two of them need saying out loud:
 *
 *   Price      the LAST TRADE, not a mid and not a quote. On a thin token that trade can be
 *              hours old and away from where the pool would fill now, and nothing here
 *              corrects for it. The column header says so and the note under the table says
 *              it again, because a column called "Price" is read as a market price.
 *   24H change measured from the last trade at or before the 24h boundary to that same last
 *              trade. Null — not zero — when the window holds no trade that old, which is
 *              what a token that first traded today looks like.
 *
 * There is no holder count, no market cap and no supply: all three need an ERC-20 transfer
 * index, and a market cap computed from a last trade and a supply nobody read would be two
 * guesses multiplied together.
 */

import { assets, meta } from './data.js';
import { mountChrome, mountFoot } from './chrome.js';
import { assetTile, compact, el, icon, ICONS, node, price, signed } from './format.js';

const PAGE = 40;

/** @typedef {{symbol: string, kind: string, price: number|null, change24h: number|null,
 *   volume24h: number, volume: number, traders: number, trades: number}} Asset */

const KINDS = [
  { id: 'all', label: 'All' },
  { id: 'stock', label: 'Stocks' },
  { id: 'meme', label: 'Memecoins' },
];

const state = {
  /** @type {Asset[]} */ rows: [],
  /** @type {any} */ meta: null,
  kind: 'all',
  query: '',
  sort: /** @type {'volume24h' | 'volume' | 'traders' | 'trades' | 'change24h' | 'symbol'} */ ('volume24h'),
  dir: -1,
  limit: PAGE,
};

/** @typedef {{key: string, label: string, align: 'left' | 'right', sortable?: boolean}} Column */
/** @type {Column[]} */
const COLUMNS = ([
  { key: 'symbol', label: 'Token', align: 'left' },
  { key: 'price', label: 'Last trade', align: 'right', sortable: false },
  { key: 'change24h', label: '24H', align: 'right' },
  { key: 'volume24h', label: '24H volume', align: 'right' },
  { key: 'volume', label: 'Window volume', align: 'right' },
  { key: 'traders', label: 'Traders', align: 'right' },
  { key: 'trades', label: 'Trades', align: 'right' },
]);

/** @param {Asset} a */
function row(a) {
  const r = node('a', 'row mk-row');
  r.setAttribute('href', `/asset?symbol=${encodeURIComponent(a.symbol)}`);
  r.setAttribute('aria-label', `Open ${a.symbol}`);

  const who = node('div', 'row-who');
  who.append(assetTile(a.symbol, a.kind));
  who.append(node('span', 'mk-sym', a.symbol));
  who.append(node('span', 'mk-kind', a.kind === 'meme' ? 'Memecoin' : 'Stock'));
  r.append(who);

  r.append(node('div', 'row-cell num', a.price === null ? '—' : price(a.price)));

  // A change is a signed figure, so it carries the sign three ways. A missing one is a dash
  // and not a zero: "no trade 24 hours back" and "flat" are different facts.
  const chg = node('div', 'row-cell num');
  if (a.change24h === null || !Number.isFinite(a.change24h)) {
    chg.append(node('span', 'mk-none', '—'));
    chg.title = 'No trade in this window 24 hours back to measure from';
  } else {
    chg.append(signed(a.change24h, undefined, (/** @type {number} */ n) => `${n.toFixed(2)}%`));
  }
  r.append(chg);

  r.append(node('div', 'row-cell num', compact(a.volume24h)));
  r.append(node('div', 'row-cell num', compact(a.volume)));
  r.append(node('div', 'row-cell num', Number(a.traders).toLocaleString('en-US')));
  r.append(node('div', 'row-cell num', Number(a.trades).toLocaleString('en-US')));
  return r;
}

function visible() {
  const q = state.query.trim().toLowerCase();
  const rows = state.rows.filter((a) => (state.kind === 'all' || a.kind === state.kind)
    && (!q || a.symbol.toLowerCase().includes(q)));
  const key = state.sort;
  return rows.sort((a, b) => {
    if (key === 'symbol') return a.symbol.localeCompare(b.symbol) * state.dir * -1;
    // A token with no 24h change sorts to the bottom whichever way the column is pointed:
    // it has no value, and treating "missing" as zero would file it among the flat ones.
    const av = /** @type {any} */ (a)[key];
    const bv = /** @type {any} */ (b)[key];
    if (av === null || !Number.isFinite(av)) return 1;
    if (bv === null || !Number.isFinite(bv)) return -1;
    return (av - bv) * state.dir;
  });
}

function renderHead() {
  const head = el('thead');
  head.replaceChildren();
  for (const c of COLUMNS) {
    if (c.sortable === false) {
      head.append(node('div', `th${c.align === 'right' ? ' th--r' : ''}`, c.label));
      continue;
    }
    const b = node('button', `th th--sort${c.align === 'right' ? ' th--r' : ''}`, c.label);
    /** @type {HTMLButtonElement} */ (b).type = 'button';
    const on = state.sort === c.key;
    b.setAttribute('aria-sort', on ? (state.dir === -1 ? 'descending' : 'ascending') : 'none');
    b.append(icon(12, ICONS.sort, { 'stroke-width': 2,
      opacity: on && state.dir === 1 ? 1 : 0.35 }));
    b.onclick = () => {
      if (state.sort === c.key) state.dir = /** @type {1 | -1} */ (state.dir * -1);
      else { state.sort = /** @type {any} */ (c.key); state.dir = -1; }
      render();
    };
    head.append(b);
  }
}

function render() {
  renderHead();
  const rows = visible();
  const body = el('rows');
  body.replaceChildren();
  for (const a of rows.slice(0, state.limit)) body.append(row(a));

  const empty = el('empty');
  empty.hidden = rows.length > 0;
  empty.textContent = state.query
    ? `No token here matches “${state.query}”.`
    : 'No tokens in this build yet.';

  const more = el('more');
  more.hidden = rows.length <= state.limit;
  more.textContent = `Show ${Math.min(PAGE, rows.length - state.limit)} more`;
  more.onclick = () => { state.limit += PAGE; render(); };

  el('note').textContent = `${rows.length.toLocaleString('en-US')} of `
    + `${state.rows.length.toLocaleString('en-US')} tokens traded over ${state.meta?.windowLabel ?? 'the window'}. `
    + 'Price is the last trade the tape holds for a token — an execution against a pool, not '
    + 'a mid and not a quote, and on a thin token it can be hours old. Volume is the quote '
    + 'side of every swap, converted at each trade’s own timestamp. Holder counts and '
    + 'market caps are not here: both need an ERC-20 transfer index this build does not have.';
}

function renderKinds() {
  const host = el('kinds');
  host.replaceChildren();
  for (const k of KINDS) {
    const b = node('button', undefined, k.label);
    /** @type {HTMLButtonElement} */ (b).type = 'button';
    b.setAttribute('aria-pressed', String(state.kind === k.id));
    b.onclick = () => {
      state.kind = k.id;
      state.limit = PAGE;
      renderKinds();
      render();
    };
    host.append(b);
  }
}

async function init() {
  state.meta = await meta().catch(() => null);
  mountChrome(el('chrome'), {
    current: 'markets',
    onSearch: (kind, id) => {
      if (kind === 'asset') globalThis.location.assign(`/asset?symbol=${encodeURIComponent(id)}`);
      else globalThis.location.assign(`/leaderboard?address=${encodeURIComponent(id)}`);
    },
  });
  mountFoot(el('foot'), state.meta ?? {});

  state.rows = /** @type {Asset[]} */ (await assets().catch(() => []));
  renderKinds();
  render();

  const filter = /** @type {HTMLInputElement} */ (/** @type {unknown} */ (el('filter')));
  filter.oninput = () => { state.query = filter.value; state.limit = PAGE; render(); };
}

await init();
