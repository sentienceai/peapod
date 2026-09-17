/**
 * The one seam between this frontend and the backend.
 *
 * Every page asks this module for data and nothing else — no page fetches, no page knows a
 * URL. SOURCE is 'api': the leaderboard, one address's detail, the manifest and the asset
 * list all come from the store this repo builds. lib/mock.js is still here and still
 * deterministic, because `SOURCE = 'mock'` is how you run the frontend with no database at
 * all, but nothing ships from it.
 *
 * TWO SHAPES, ONE PLACE. The store speaks snake_case and groups an address's figures under
 * `summary`; the components read camelCase and flat. fromApiRow() and fromApiDetail() are
 * the whole of that translation, so a rename upstream is one edit here rather than forty
 * across the pages.
 *
 * WHAT IS STILL NOT WIRED, and why it is not faked:
 *   holders(symbol)  balances per address. A holder may never have swapped — most holdings
 *                    here arrived by transfer, issuance or bridge — so the swap tape cannot
 *                    answer it at all. It needs an ERC-20 transfer index and a balance
 *                    engine over it. Every holder figure renders as an unwired slot naming
 *                    that, never as a number. See lib/needs.js.
 *
 * SAMPLE MARKS ARE PER FIGURE. `sampleFields` on a payload names exactly which of its own
 * fields came from the mock, and the component marks those and only those. A single global
 * "this page is sample data" flag was the old shape, and it fails in the direction that
 * matters: the moment the rows go live the mark disappears from the whole page, including
 * from the figures beside them that are still invented.
 */

import * as mock from './mock.js';

/**
 * Where every figure on the site comes from.
 *
 * Read through mode() rather than compared directly: the type checker narrows a literal
 * union down to whichever value is written here, so comparing the constant directly reads as
 * "these types have no overlap" — a type error for writing the switch this module exists
 * to be. Going through a function keeps both arms type-checked.
 * @type {{ value: 'mock' | 'api' }}
 */
const SOURCE = { value: 'api' };
/** @returns {'mock' | 'api'} */
const mode = () => SOURCE.value;

/** True only while the whole module is answering from lib/mock.js. */
export const isSample = () => mode() === 'mock';

/**
 * Which fields of a payload are sample data. Empty on a live payload — and a figure asks
 * this rather than asking whether the build as a whole is live.
 * @param {{sampleFields?: string[]} | null | undefined} payload @param {string} field
 */
export const isSampleField = (payload, field) => Boolean(payload?.sampleFields?.includes(field));

/** @param {string} path */
async function get(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

/**
 * The scopes the build actually publishes, as the universe tabs read them.
 *
 * A scope is a separate build: switching one refolds the matching on that scope's trades
 * rather than filtering rows, because an address that trades both universes carries a
 * different realized figure inside each. The labels are ours; the ids and their existence
 * are the manifest's, so a tab can never offer a scope with no build behind it.
 */
const UNIVERSE_LABELS = /** @type {Record<string, string>} */ ({
  all: 'All', rwa: 'Stocks', pons: 'Memecoins',
});
/** @param {string} id */
const scopeOf = (id) => (id === 'stocks' ? 'rwa' : id === 'memecoins' ? 'pons' : id);

/**
 * Build-level facts: which windows exist, which universes exist, how big the field is.
 *
 * WINDOWS AND UNIVERSES COME FROM THE MANIFEST. They used to come from the mock even while
 * the rows underneath were live, which is worse than an obviously fake page: the tabs would
 * offer 30D on a build that folds 24h and 7d, and the one that does not exist would answer
 * with the one that does. windowLabel is derived from the default window rather than
 * written down, for the same reason.
 */
export async function meta() {
  if (mode() === 'mock') return { ...mock.META, sample: true, sampleFields: ['*'] };
  const m = await get('/api/manifest');
  const windows = (m.windows ?? []).map((/** @type {any} */ w) => ({
    id: w.window, label: String(w.label ?? w.window).toUpperCase(),
  }));
  // The longest window the build publishes is the one a page opens on: a tape younger than
  // seven days publishes only 24h, and a page that assumes 7d shows an empty grid over a
  // store with data in it.
  const current = windows.at(-1) ?? { id: '7d', label: '7D' };
  const universes = (m.scopes ?? [])
    .filter((/** @type {any} */ s) => !s.quote && UNIVERSE_LABELS[s.id])
    .map((/** @type {any} */ s) => ({ id: s.id, label: UNIVERSE_LABELS[s.id] }));
  return {
    build: m.build, builtAt: m.built_at, chain: 'Robinhood Chain',
    addressesSeen: m.addresses, addressesQualifying: m.qualifying,
    windows, universes, window: current.id, windowLabel: current.label,
    empty: Boolean(m.empty), sample: false, sampleFields: [],
  };
}

/**
 * The board for one universe and one window.
 * @param {{universe?: string, window?: string}} [opts]
 */
export async function board(opts = {}) {
  const universe = opts.universe ?? 'all';
  if (mode() === 'mock') {
    const rows = mock.TRADERS
      .filter((t) => universe === 'all' || t.universes.includes(universe))
      .map((t, i) => ({ ...t, rank: i + 1 }));
    return { rows, window: opts.window ?? '7d', universe, tapeEnd: mock.TAPE_END,
      coverage: null, sample: true, sampleFields: ['*'] };
  }
  const window = opts.window ?? '7d';
  const raw = await get(`/api/leaderboard/${scopeOf(universe)}/${window}`);
  return {
    rows: (raw.rows ?? []).map(fromApiRow),
    window, universe, tapeEnd: raw.to_ts,
    // The caveat the board prints comes from the build, not from the page: what the window
    // is, which pools, how many qualified out of how many, and how much of the flow has no
    // round-trip behind it at all.
    coverage: raw.coverage ?? null,
    provenance: raw.provenance ?? null,
    distribution: raw.distribution ?? null,
    sample: false, sampleFields: [],
  };
}

/** The live row shape → this frontend's. One place, so a rename upstream is one edit here. */
function fromApiRow(/** @type {any} */ r) {
  const coverage = r.total_volume ? ((r.total_volume - r.out_of_scope_volume) / r.total_volume) * 100 : 0;
  return {
    rank: r.rank, address: r.address, realized: r.realized,
    // Return on the cost of the buys that were matched — not account ROI, which needs the
    // transfer index. matched_volume is cost + proceeds and realized is proceeds − cost, so
    // the cost is exact: see lib/figures.js.
    realizedPct: r.matched_volume - r.realized > 0
      ? (r.realized / ((r.matched_volume - r.realized) / 2)) * 100 : 0,
    matchedVolume: r.matched_volume, totalVolume: r.total_volume,
    matchedSharePct: r.total_volume ? (r.matched_volume / r.total_volume) * 100 : 0,
    outOfScopeVolume: r.out_of_scope_volume,
    coveragePct: coverage,
    winRate: r.win_rate, wins: r.wins, roundTrips: r.round_trips,
    tokens: r.tokens ?? [], tokenCount: r.token_count ?? (r.tokens ?? []).length,
    lastTs: r.last_ts,
    series: (r.spark ?? []).map((/** @type {number} */ v, /** @type {number} */ i) => [i, v]),
    universes: r.universes ?? [],
  };
}

/**
 * One address's detail.
 *
 * Three answers, all of them real states: the record of an address that closed round-trips,
 * the explanation for one that traded without closing any, and null for one the tape has
 * never seen. The middle case is the one that used to be dropped — `status === 'qualified'`
 * or nothing — and it is the commonest: 73,907 of the 103,920 addresses in this window
 * traded without ever closing a round-trip, and each of them has a page that says what it
 * did do rather than a page that says it does not exist.
 * @param {string} address
 */
export async function trader(address) {
  if (mode() === 'mock') return mock.traderDetail(address);
  const res = await fetch(`/api/address/${address}`, { headers: { accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`/api/address answered ${res.status}`);
  return fromApiDetail(await res.json());
}

/**
 * The store's address payload → the shape the profile reads.
 * @param {any} d
 */
function fromApiDetail(d) {
  const s = d.summary ?? {};
  const kind = (/** @type {string} */ token) => (d.universes?.includes('pons') && !d.universes?.includes('rwa')
    ? 'meme' : tokenKind(token));
  const cost = (s.matched_volume - s.realized) / 2;
  return {
    address: d.address,
    status: d.status,
    // Present only when the address closed nothing: what it DID do, in the build's words.
    explain: d.explain ?? null,
    realized: s.realized ?? 0,
    realizedPct: cost > 0 ? (s.realized / cost) * 100 : 0,
    matchedCost: cost > 0 ? cost : null,
    matchedVolume: s.matched_volume ?? 0,
    totalVolume: s.total_volume ?? 0,
    outOfScopeVolume: s.out_of_scope_volume ?? 0,
    matchedSharePct: s.matched_share_pct ?? 0,
    coveragePct: s.total_volume
      ? ((s.total_volume - s.out_of_scope_volume) / s.total_volume) * 100 : 0,
    winRate: s.win_rate ?? 0,
    wins: Math.round(((s.win_rate ?? 0) / 100) * (s.round_trips ?? 0)),
    roundTrips: s.round_trips ?? 0,
    positionChanges: s.position_changes ?? 0,
    tokenCount: s.tokens_traded ?? 0,
    medianHoldS: s.median_hold_s ?? 0,
    avgHoldS: s.avg_hold_s ?? 0,
    longestWinStreak: s.longest_win_streak ?? 0,
    style: s.style ?? null,
    styleBasis: s.style_basis ?? null,
    percentile: s.percentile ?? null,
    lastTs: s.last_ts ?? null,
    firstTs: s.first_ts ?? null,
    // The deepest fall of the realized curve, computed over every close by the build. Not
    // account drawdown: see lib/figures.js.
    realizedDrawdown: s.realized_drawdown ?? null,
    quoteMix: (s.quote_mix ?? []).map((/** @type {any} */ q) => ({
      quote: q.quote, pct: q.pct, volume: q.volume })),
    // Each label ships the rule that earns it; a label without its criteria is a vibe.
    labels: d.labels ?? [],
    sequence: d.sequence ?? [],
    series: d.series ?? [],
    universes: d.universes ?? [],
    field: d.field ?? null,
    roundTripList: (d.round_trips ?? []).map((/** @type {any} */ t) => ({
      symbol: t.token, kind: kind(t.token), qty: t.qty, buy: t.buy, sell: t.sell,
      heldS: t.held, closedTs: t.closed, realized: t.realized,
    })),
    trades: (d.trades ?? []).map((/** @type {any} */ t) => ({
      ts: t.ts, symbol: t.token, kind: kind(t.token), side: t.side,
      qty: t.qty, price: t.price, value: t.value,
    })),
    // The symbols themselves, for the chips: the store's `tokens` is per-token STATS, and
    // the rail wants the list. Both come off the same array.
    tokens: (d.tokens ?? []).map((/** @type {any} */ t) => t.token),
    tokenStats: (d.tokens ?? []).map((/** @type {any} */ t) => ({
      symbol: t.token, kind: kind(t.token), roundTrips: t.round_trips,
      winRate: t.win_rate, matched: t.matched, realized: t.realized,
    })),
    daily: (d.daily ?? []).map((/** @type {any} */ x) => ({
      day: x.day, roundTrips: x.round_trips, winRate: x.win_rate, realized: x.realized,
    })),
    sample: false,
    sampleFields: [],
  };
}

/**
 * Symbol → kind, for the asset tiles. Filled from /api/assets on first use; a token the
 * list does not carry draws as a stock rather than guessing something louder.
 * @type {Map<string, string>}
 */
const KINDS = new Map();
/** @param {string} symbol */
function tokenKind(symbol) {
  return KINDS.get(String(symbol).toUpperCase()) ?? 'stock';
}

/**
 * Every asset the tape has traded in the window, with a price and a 24h volume.
 *
 * Both are computed from the swap tape at build time — the same trades the leaderboard is
 * folded from — so this needs no data the build does not already hold.
 */
export async function assets() {
  if (mode() === 'mock') return mock.ASSETS;
  const list = await get('/api/assets');
  for (const a of list) KINDS.set(String(a.symbol).toUpperCase(), a.kind);
  return list;
}

/**
 * One asset: its price, its tape, and the holder side it cannot answer.
 *
 * `holders` is null and stays null until there is a transfer index. The page renders the
 * holder panels as unwired slots naming that, rather than drawing a cluster of invented
 * wallets — which is what the frames drew and what the mock still produces.
 * @param {string} symbol
 */
export async function assetDetail(symbol) {
  if (mode() === 'mock') {
    const a = mock.asset(symbol);
    if (!a) return null;
    return { ...a, holders: mock.assetHolders(symbol), trades: mock.assetTrades(symbol),
      series: mock.assetSeries(symbol), sample: true, sampleFields: ['*'] };
  }
  const res = await fetch(`/api/asset/${encodeURIComponent(symbol)}`, { headers: { accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`/api/asset answered ${res.status}`);
  const d = await res.json();
  // The endpoint nests the summary under `asset` because its own `trades` is a COUNT while
  // the detail's is a LIST, and one key cannot mean both. Flattened here, where the two
  // shapes already meet.
  return {
    ...d.asset,
    // The tape knows tickers, not company names: nothing in the build carries "Tesla, Inc."
    // The page prints the symbol alone rather than inventing an expansion of it.
    name: null,
    series: d.series ?? [],
    trades: d.trades ?? [],
    // Not null-as-unknown: the holder side needs an ERC-20 transfer index, and every holder
    // figure on the page renders as a slot naming that. See lib/needs.js.
    holders: null,
    sample: false, sampleFields: [],
  };
}

/**
 * The ticker → logo-file map, through the seam like everything else.
 *
 * Fetched once and cached: it is one small object for the whole session, and the pages
 * need it synchronously when they draw a tile. A ticker with no file draws its initials.
 */
let logoMap = /** @type {Promise<Record<string, string>> | null} */ (null);
export function tokenLogos() {
  if (mode() === 'mock') return Promise.resolve({});
  if (!logoMap) {
    logoMap = get('/api/leaderboard/tokens/tokens').catch(() => ({}));
  }
  return logoMap;
}

/**
 * The search index.
 *
 * Both lists come from what the app already holds, and the panel says so: a search that
 * answers "no results" for an address simply below the board's cut is worse than one that
 * admits what it can see. A complete address is offered whether or not it is on the board,
 * because the detail endpoint knows every address that ever traded.
 * @param {string} query
 */
export async function search(query) {
  const q = String(query ?? '').trim().toLowerCase();
  const [{ rows }, list] = await Promise.all([board(), assets()]);
  const assetHits = list.filter((/** @type {any} */ a) => !q
    || a.symbol.toLowerCase().includes(q)
    || String(a.name ?? '').toLowerCase().includes(q)).slice(0, 30);
  const traderHits = rows.filter((/** @type {any} */ t) => !q || t.address.toLowerCase().includes(q)).slice(0, 30);
  const direct = /^0x[0-9a-f]{40}$/.test(q) && !traderHits.some((/** @type {any} */ t) => t.address === q) ? q : null;
  return { assets: assetHits, traders: traderHits, direct };
}
