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
import { assetTile, compact, el, icon, ICONS, node, price, signed, units } from './format.js';

const PAGE = 40;

/** @typedef {{symbol: string, kind: string, price: number|null, change1h: number|null,
 *   change24h: number|null, change7d: number|null, supply: number|null,
 *   market_cap: number|null, volume24h: number, volume: number, traders: number,
 *   trades: number}} Asset */

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
  sort: /** @type {string} */ ('volume24h'),
  dir: -1,
  limit: PAGE,
};

/** @typedef {{key: string, label: string, align: 'left' | 'right', sortable?: boolean}} Column */
/** @type {Column[]} */
const COLUMNS = ([
  { key: 'symbol', label: 'Token', align: 'left' },
  { key: 'price', label: 'Last trade', align: 'right', sortable: false },
  { key: 'change1h', label: '1H', align: 'right' },
  { key: 'change24h', label: '24H', align: 'right' },
  { key: 'change7d', label: '7D', align: 'right' },
  // "Token mcap", not "Market cap": these are tokens issued on Robinhood Chain, and the
  // supply on this chain is a small fraction of the company's shares. NVDA's token cap is
  // tens of millions against a company in the trillions, and a column headed "Market cap"
  // beside a ticker everybody recognises will be read as the company's every time.
  { key: 'market_cap', label: 'Token mcap', align: 'right' },
  { key: 'supply', label: 'Supply', align: 'right' },
  { key: 'volume24h', label: '24H volume', align: 'right' },
  { key: 'traders', label: 'Traders', align: 'right' },
  { key: 'trades', label: 'Trades', align: 'right' },
]);

/**
 * A cell with nothing in it, and a reason a pointer can find.
 *
 * NOT A DASH AND NOT A ZERO. A zero is a measurement — "it did not move", "nothing is
 * issued" — and this is the absence of one. A dash is better but it is still a mark in a
 * column of figures, and on a table with three change columns most rows would be dashes
 * for want of a tape that goes back far enough. So the cell is empty and says why when
 * asked.
 * @param {string} why
 */
function blank(why) {
  const cell = node('div', 'row-cell num mk-none');
  cell.title = why;
  return cell;
}

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

  // A price of zero is not a price — one token on this tape divides out to exactly that —
  // so the build sends null and the cell is empty.
  r.append(a.price === null || !Number.isFinite(a.price)
    ? blank('The last trade on this tape divides out to zero; that is not a price')
    : node('div', 'row-cell num', price(a.price)));

  // Each change is a signed figure and carries the sign three ways. An absent one means the
  // tape holds no trade at or before that boundary — for 7D, that is every token that first
  // traded inside the last week, and every token at all until the tape is a week deep.
  for (const [key, label] of [['change1h', 'an hour'], ['change24h', '24 hours'],
    ['change7d', '7 days']]) {
    const v = /** @type {any} */ (a)[key];
    if (v === null || !Number.isFinite(v)) {
      r.append(blank(`No trade on this tape ${label} back to measure from`));
    } else {
      const cell = node('div', 'row-cell num');
      cell.append(signed(v, undefined, (/** @type {number} */ n) => `${n.toFixed(2)}%`));
      r.append(cell);
    }
  }

  r.append(a.market_cap === null || !Number.isFinite(a.market_cap)
    ? blank('Needs both a price and a supply this build could read')
    : node('div', 'row-cell num', compact(a.market_cap)));
  r.append(a.supply === null || !Number.isFinite(a.supply)
    ? blank('This token did not answer totalSupply(), or its decimals are unknown')
    : node('div', 'row-cell num', units(a.supply)));

  r.append(node('div', 'row-cell num', compact(a.volume24h)));
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
    + 'a mid and not a quote, and on a thin token it can be hours old. 1H, 24H and 7D compare '
    + 'it with the last trade at or before each of those marks; a token with no trade that far '
    + 'back shows nothing there, and nothing is also what the whole 7D column shows until the '
    + 'tape itself is seven days deep. Supply is totalSupply() read from each token contract '
    + 'once per build — these tokens are minted and burned as people move the underlying on '
    + 'and off this chain, so it moves. Token mcap is that supply times that last trade: it is '
    + 'the market cap of the TOKEN on Robinhood Chain and not of the company, and for a '
    + 'tokenized equity the two are orders of magnitude apart. Volume is the quote side of '
    + 'every swap, converted at each trade\u2019s own timestamp. Holder counts are not here: '
    + 'they need an ERC-20 transfer index this build does not have.';
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
