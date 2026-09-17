/**
 * The one seam between this frontend and a backend.
 *
 * Every page asks this module for data and nothing else — no page fetches, no page knows a
 * URL. Today it answers from lib/mock.js. When the endpoints exist, set SOURCE to 'api' and
 * fill in the four fetches marked below; nothing else in the frontend changes, because the
 * shapes these functions return are the shapes the components read.
 *
 * WHAT THE BACKEND HAS TO PROVIDE, in the order of how much work each is:
 *
 *   board(scope, window)   → the leaderboard. This exists today as
 *                            /api/leaderboard/:scope/:window.
 *   trader(address)        → one address's detail. Exists as /api/address/:address.
 *   assets()               → the traded universe with a price and a 24h volume per asset.
 *                            Computable from the swap tape; nothing serves it per asset yet.
 *   holders(symbol)        → balances per address. This one needs a transfer index, because
 *                            a holder may never have swapped, and it is the long pole.
 *
 * EVERY FIGURE THIS MODULE HANDS OUT WHILE SOURCE IS 'mock' IS SAMPLE DATA. isSample() says
 * so, and every page that shows a number carries the mark. That is not a disclaimer for its
 * own sake: a plausible number with no source behind it is the one thing a page like this
 * must never quietly show.
 */

import * as mock from './mock.js';

/** @type {'mock' | 'api'} */
const SOURCE = 'mock';

export const isSample = () => SOURCE === 'mock';

/** @param {string} path */
async function get(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

export async function meta() {
  if (SOURCE === 'mock') return { ...mock.META, sample: true };
  const m = await get('/api/manifest');
  return {
    build: m.build, builtAt: m.built_at, chain: 'Robinhood Chain',
    addressesSeen: m.addresses, addressesQualifying: m.qualifying,
    windowLabel: '7 days', windows: mock.META.windows, universes: mock.META.universes,
    sample: false,
  };
}

/**
 * The board for one universe and one window.
 *
 * The universe filter is applied to whole ROWS here because the mock is one folded tape. The
 * live API refolds the matching per scope instead — an address that trades both universes
 * has a different realized figure inside each one — so when SOURCE flips, pass the scope
 * through rather than filtering what came back.
 * @param {{universe?: string, window?: string}} [opts]
 */
export async function board(opts = {}) {
  const universe = opts.universe ?? 'all';
  if (SOURCE === 'mock') {
    const rows = mock.TRADERS
      .filter((t) => universe === 'all' || t.universes.includes(universe))
      .map((t, i) => ({ ...t, rank: i + 1 }));
    return { rows, window: opts.window ?? '7d', universe, tapeEnd: mock.TAPE_END, sample: true };
  }
  const scope = universe === 'all' ? 'all' : universe === 'stocks' ? 'rwa' : 'pons';
  const raw = await get(`/api/leaderboard/${scope}/${opts.window ?? '7d'}`);
  return { rows: raw.rows.map(fromApiRow), window: opts.window ?? '7d', universe,
    tapeEnd: raw.to_ts, sample: false };
}

/** The live row shape → this frontend's. One place, so a rename upstream is one edit here. */
function fromApiRow(/** @type {any} */ r) {
  return {
    rank: r.rank, address: r.address, realized: r.realized,
    realizedPct: r.matched_volume ? (r.realized / r.matched_volume) * 100 : 0,
    matchedVolume: r.matched_volume, totalVolume: r.total_volume,
    matchedSharePct: r.total_volume ? (r.matched_volume / r.total_volume) * 100 : 0,
    outOfScopeVolume: r.out_of_scope_volume,
    coveragePct: r.total_volume ? (r.matched_volume / r.total_volume) * 100 : 0,
    winRate: r.win_rate, wins: r.wins, roundTrips: r.round_trips,
    tokens: r.tokens ?? [], tokenCount: r.token_count ?? (r.tokens ?? []).length,
    lastTs: r.last_ts, series: (r.spark ?? []).map((/** @type {number} */ v, /** @type {number} */ i) => [i, v]),
    universes: [],
  };
}

/** @param {string} address */
export async function trader(address) {
  if (SOURCE === 'mock') return mock.traderDetail(address);
  const d = await get(`/api/address/${address}`);
  return d.status === 'qualified' ? d : null;
}

export async function assets() {
  if (SOURCE === 'mock') return mock.ASSETS;
  return get('/api/assets');
}

/** @param {string} symbol */
export async function assetDetail(symbol) {
  if (SOURCE === 'mock') {
    const a = mock.asset(symbol);
    if (!a) return null;
    return { ...a, holders: mock.assetHolders(symbol), trades: mock.assetTrades(symbol),
      series: mock.assetSeries(symbol), sample: true };
  }
  return get(`/api/asset/${encodeURIComponent(symbol)}`);
}

/**
 * The search index.
 *
 * Both lists come from what the app already holds, and the panel says so: a search that
 * answers "no results" for an address simply below the board's cut is worse than one that
 * admits what it can see. A complete address is offered whether or not it is on the board,
 * because the detail endpoint knows every address.
 * @param {string} query
 */
export async function search(query) {
  const q = String(query ?? '').trim().toLowerCase();
  const [{ rows }, list] = await Promise.all([board(), assets()]);
  const assetHits = list.filter((a) => !q
    || a.symbol.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)).slice(0, 30);
  const traderHits = rows.filter((t) => !q || t.address.toLowerCase().includes(q)).slice(0, 30);
  const direct = /^0x[0-9a-f]{40}$/.test(q) && !traderHits.some((t) => t.address === q) ? q : null;
  return { assets: assetHits, traders: traderHits, direct };
}
