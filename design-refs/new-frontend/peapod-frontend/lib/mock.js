/**
 * The mock dataset: one deterministic tape the whole frontend is built against.
 *
 * WHY DETERMINISTIC. Every page, every screenshot and every review has to show the same
 * numbers, or a layout bug and a data change look identical. The generator below is a plain
 * LCG with a fixed seed, so the fiftieth address is the same fiftieth address on every
 * machine and every reload.
 *
 * WHY IT LOOKS LIKE THE REAL THING. The shapes here are the shapes the live API serves —
 * realized PnL on closed round-trips, matched volume, a win count out of a round-trip count,
 * per-token stats — so lib/data.js can be pointed at the real endpoints without a single
 * component changing. The one thing this file must never do is invent a FIELD the backend
 * will not have: a figure that exists only in the mock becomes a slot nobody can fill.
 *
 * WHAT IS ADMITTEDLY FICTION: the prices, the 24h volumes and the holder balances. Those
 * need an asset endpoint and a transfer index; they are here so the asset page can be built
 * and reviewed, and every page that shows them carries the "sample data" mark from
 * lib/data.js. Delete the mark when the endpoints land, not before.
 */

/* A 1969 LCG. Small, exactly reproducible, and nobody has to trust a hash function for a
   dataset whose only job is to look plausible. */
function rng(seed) {
  let s = seed % 233280;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

/** The tape ends here. Everything on the site is measured back from this, never from now. */
export const TAPE_END = Math.floor(Date.UTC(2026, 8, 16, 21, 0, 0) / 1000);

export const META = {
  build: '2026-09-16T21:00Z-4f1c2a',
  builtAt: TAPE_END + 240,
  chain: 'Robinhood Chain',
  addressesSeen: 48210,
  addressesQualifying: 6142,
  windowLabel: '7 days',
  windows: [
    { id: '24h', label: '24H' },
    { id: '7d', label: '7D' },
    { id: '30d', label: '30D' },
  ],
  universes: [
    { id: 'all', label: 'All' },
    { id: 'stocks', label: 'Stocks' },
    { id: 'memecoins', label: 'Memecoins' },
  ],
};

/** @type {{symbol: string, name: string, kind: string}[]} */
const ASSET_SEED = [
  ['TSLA', 'Tesla', 'stock'], ['NVDA', 'NVIDIA', 'stock'], ['AAPL', 'Apple', 'stock'],
  ['MSTR', 'MicroStrategy', 'stock'], ['HOOD', 'Robinhood Markets', 'stock'],
  ['COIN', 'Coinbase', 'stock'], ['GME', 'GameStop', 'stock'], ['AMD', 'AMD', 'stock'],
  ['META', 'Meta Platforms', 'stock'], ['AMZN', 'Amazon', 'stock'],
  ['GOOGL', 'Alphabet', 'stock'], ['PLTR', 'Palantir', 'stock'],
  ['SPY', 'S&P 500 ETF', 'etf'], ['QQQ', 'Nasdaq 100 ETF', 'etf'], ['IWM', 'Russell 2000 ETF', 'etf'],
  ['ETH', 'Ether', 'crypto'], ['WBTC', 'Wrapped Bitcoin', 'crypto'],
  ['USDG', 'Global Dollar', 'stable'], ['USDC', 'USD Coin', 'stable'],
  ['PONS', 'Pons', 'meme'], ['HOODIE', 'Hoodie', 'meme'], ['VLAD', 'Vlad', 'meme'],
  ['TENDIE', 'Tendies', 'meme'], ['MOONER', 'Mooner', 'meme'], ['DIAMOND', 'Diamond Hands', 'meme'],
  ['APE', 'Apeman', 'meme'], ['ROCKET', 'Rocket', 'meme'], ['BAGS', 'Bagholder', 'meme'],
].map(([symbol, name, kind]) => ({ symbol, name, kind }));

const r0 = rng(20260916);
export const ASSETS = ASSET_SEED.map((a, i) => {
  const stable = a.kind === 'stable';
  const price = stable ? 1 : a.kind === 'meme' ? 0.0004 + r0() * 0.08
    : a.kind === 'crypto' ? 900 + r0() * 3400 : 24 + r0() * 460;
  return {
    ...a,
    price,
    change24h: stable ? (r0() - 0.5) * 0.06 : (r0() - 0.42) * (a.kind === 'meme' ? 34 : 7),
    volume24h: (a.kind === 'meme' ? 40e3 : 2.4e6) * (0.4 + r0() * 3.2),
    traders: 60 + Math.floor(r0() * 900),
    holders: 400 + Math.floor(r0() * 22000),
    rank: i + 1,
  };
});

const BY_SYMBOL = new Map(ASSETS.map((a) => [a.symbol, a]));
/** @param {string} symbol */
export const asset = (symbol) => BY_SYMBOL.get(String(symbol).toUpperCase()) ?? null;

const STYLES = ['Swing, equities', 'Intraday, memecoins', 'Position, equities',
  'Scalper, mixed', 'Swing, mixed'];

/** @param {() => number} rand */
function address(rand) {
  let out = '0x';
  for (let i = 0; i < 40; i += 1) out += '0123456789abcdef'[Math.floor(rand() * 16)];
  return out;
}

/**
 * The board: 60 addresses, ranked by realized PnL on closed round-trips.
 *
 * The shape of the field is deliberate and it is the argument the site makes: the top row is
 * two orders of magnitude above the median, about a fifth of the field lost money, and the
 * tail is measured in tens of dollars. A leaderboard whose fiftieth row makes $900 is a
 * leaderboard nobody should believe.
 */
export const TRADERS = (() => {
  const rand = rng(4242);
  /** @type {any[]} */
  const out = [];
  for (let i = 0; i < 60; i += 1) {
    const addr = address(rand);
    const roundTrips = 3 + Math.floor(rand() * 44);
    const winRate = 28 + rand() * 58;
    const wins = Math.max(0, Math.min(roundTrips, Math.round((winRate / 100) * roundTrips)));
    const losing = rand() > 0.84;
    const realized = Math.round((18400 / (i + 1.6) ** 1.35) * (losing ? -0.55 : 1) * 100) / 100;
    const matchedVolume = Math.abs(realized) * (9 + rand() * 46) + 1200;
    const totalVolume = matchedVolume * (1.1 + rand() * 0.9);
    const kinds = rand() > 0.55 ? ['stock', 'etf'] : rand() > 0.4 ? ['meme'] : ['stock', 'meme', 'crypto'];
    const pool = ASSETS.filter((a) => kinds.includes(a.kind));
    const tokenCount = 1 + Math.floor(rand() * Math.min(7, pool.length));
    /** @type {string[]} */
    const tokens = [];
    while (tokens.length < tokenCount) {
      const t = pool[Math.floor(rand() * pool.length)].symbol;
      if (!tokens.includes(t)) tokens.push(t);
    }
    /* The realized curve. It only moves when something closes, which is what makes it a
       REALIZED curve rather than a mark-to-market line — and it has to ARRIVE at the row's
       realized figure, because the card draws both and a curve that ends somewhere else is
       the first thing a reader notices. So: a mean-zero wobble around a straight path to the
       total, with the last point pinned exactly. The first attempt walked freely and then
       appended the total, which drew thirty flat steps and a cliff. */
    const steps = 32;
    const wobble = Math.abs(realized) * 0.22;
    let drift = 0;
    const series = Array.from({ length: steps }, (_, k) => {
      drift += (rand() - 0.5) * wobble * 0.6;
      // The wobble is damped toward the ends so the curve leaves zero and lands on the total
      // without a step at either edge.
      const t = k / (steps - 1);
      const damp = Math.sin(Math.PI * t);
      const value = realized * t + drift * damp;
      return [TAPE_END - (steps - 1 - k) * 5 * 3600, Math.round(value * 100) / 100];
    });
    series[0] = [series[0][0], 0];
    series[steps - 1] = [TAPE_END, realized];
    const sequence = Array.from({ length: roundTrips }, (_, k) => (k < wins ? 1 : 0));
    for (let k = sequence.length - 1; k > 0; k -= 1) {
      const j = Math.floor(rand() * (k + 1));
      [sequence[k], sequence[j]] = [sequence[j], sequence[k]];
    }
    out.push({
      rank: i + 1,
      address: addr,
      realized,
      realizedPct: (realized / matchedVolume) * 100,
      matchedVolume,
      totalVolume,
      matchedSharePct: (matchedVolume / totalVolume) * 100,
      outOfScopeVolume: totalVolume - matchedVolume,
      coveragePct: (matchedVolume / totalVolume) * 100,
      winRate: (wins / roundTrips) * 100,
      wins,
      roundTrips,
      tokens,
      tokenCount,
      positionChanges: roundTrips * 2 + Math.floor(rand() * 9),
      lastTs: TAPE_END - Math.floor(rand() * 540000),
      medianHoldS: 1800 + Math.floor(rand() * 260000),
      avgHoldS: 3600 + Math.floor(rand() * 320000),
      longestWinStreak: 1 + Math.floor(rand() * 7),
      style: STYLES[Math.floor(rand() * STYLES.length)],
      percentile: 99.9 - (i / 60) * 38,
      quoteMix: (() => {
        const usdg = 52 + rand() * 46;
        return [
          { quote: 'USDG', pct: usdg, volume: totalVolume * (usdg / 100) },
          { quote: 'ETH', pct: 100 - usdg, volume: totalVolume * (1 - usdg / 100) },
        ];
      })(),
      sequence,
      series,
      universes: kinds.includes('meme') ? (kinds.length > 1 ? ['stocks', 'memecoins'] : ['memecoins']) : ['stocks'],
    });
  }
  return out;
})();

const BY_ADDRESS = new Map(TRADERS.map((t) => [t.address, t]));

/**
 * The detail behind one address: its closed round-trips, its position changes, its tokens
 * and its days. Generated from the row so the totals agree with the board — a detail page
 * whose rows do not add up to the row that opened it is the fastest way to lose a reader.
 * @param {string} addr
 */
export function traderDetail(addr) {
  const row = BY_ADDRESS.get(String(addr).toLowerCase()) ?? null;
  if (!row) return null;
  const rand = rng(Number.parseInt(row.address.slice(2, 8), 16) % 233280);
  const shown = Math.min(row.roundTrips, 14);
  const per = row.realized / row.roundTrips;

  const positions = Array.from({ length: shown }, (_, i) => {
    const symbol = row.tokens[i % row.tokens.length];
    const a = asset(symbol);
    const win = row.sequence[i] === 1;
    const realized = Math.round(per * (win ? 1.6 + rand() : -(0.4 + rand() * 0.8)) * 100) / 100;
    const qty = a.kind === 'meme' ? 4000 + rand() * 90000 : 2 + rand() * 60;
    const buy = a.price * (0.86 + rand() * 0.2);
    return {
      symbol, kind: a.kind, qty,
      buy, sell: buy * (1 + realized / Math.max(1, qty * buy)),
      heldS: 2400 + Math.floor(rand() * 400000),
      closedTs: TAPE_END - Math.floor(rand() * 560000),
      realized,
    };
  }).sort((a, b) => b.closedTs - a.closedTs);

  const trades = Array.from({ length: 18 }, (_, i) => {
    const symbol = row.tokens[i % row.tokens.length];
    const a = asset(symbol);
    const side = rand() > 0.5 ? 'buy' : 'sell';
    const qty = a.kind === 'meme' ? 3000 + rand() * 80000 : 1 + rand() * 40;
    const price = a.price * (0.9 + rand() * 0.22);
    return { ts: TAPE_END - i * (7000 + Math.floor(rand() * 20000)), symbol, kind: a.kind, side, qty, price, value: qty * price };
  });

  const tokenStats = row.tokens.map((symbol) => {
    const trips = 1 + Math.floor(rand() * Math.max(2, row.roundTrips / row.tokens.length));
    return {
      symbol, kind: asset(symbol).kind, roundTrips: trips,
      winRate: 24 + rand() * 70,
      matched: row.matchedVolume * (0.05 + rand() * 0.5),
      realized: Math.round(per * trips * (rand() * 2.2 - 0.5) * 100) / 100,
    };
  }).sort((a, b) => b.matched - a.matched);

  const daily = Array.from({ length: 7 }, (_, i) => ({
    day: `2026-09-${10 + i}`,
    roundTrips: Math.floor(rand() * 9),
    winRate: 20 + rand() * 74,
    realized: Math.round((row.realized / 7) * (rand() * 2.6 - 0.6) * 100) / 100,
  }));

  return { ...row, positions, trades, tokenStats, daily };
}

/**
 * Who holds an asset, for the cluster and the table.
 *
 * NOT DERIVED FROM THE BOARD. A holder may never have swapped — that is the whole reason
 * this needs a transfer index in production — so the mock generates its own set rather than
 * pretending the leaderboard is the holder list, which would teach the page a shape the real
 * data will not have.
 * @param {string} symbol
 */
export function assetHolders(symbol) {
  const a = asset(symbol);
  if (!a) return [];
  const rand = rng(Number.parseInt(symbol.split('').map((c) => c.charCodeAt(0)).join('').slice(0, 6), 10) % 233280 || 77);
  const total = a.holders;
  /** @type {any[]} */
  const out = [];
  // A power law, because holdings are one: the top wallet holds about a fifth of the float
  // on this chain and the fortieth holds a rounding error. A flat distribution would draw a
  // cluster of identical bubbles, which is a picture of nothing.
  let remaining = 100;
  for (let i = 0; i < 40; i += 1) {
    const share = i === 0 ? 8 + rand() * 12 : Math.max(0.12, (remaining / (7 + i)) * (0.5 + rand()));
    remaining = Math.max(2, remaining - share);
    const position = (a.price * total * 3.6) * (share / 100);
    const known = i < 12 && rand() > 0.55;
    out.push({
      rank: i + 1,
      address: known ? TRADERS[Math.floor(rand() * TRADERS.length)].address : address(rand),
      onBoard: known,
      sharePct: share,
      position,
      qty: position / a.price,
      pnl: position * (rand() * 0.5 - 0.18),
      entry: a.price * (0.72 + rand() * 0.5),
      sinceTs: TAPE_END - Math.floor(rand() * 4 * 86400),
    });
  }
  return out.sort((x, y) => y.position - x.position).map((h, i) => ({ ...h, rank: i + 1 }));
}

/** Recent trades in one asset, for the asset page's tape. @param {string} symbol */
export function assetTrades(symbol) {
  const a = asset(symbol);
  if (!a) return [];
  const rand = rng((symbol.charCodeAt(0) * 977 + symbol.length * 13) % 233280);
  return Array.from({ length: 22 }, (_, i) => {
    const side = rand() > 0.48 ? 'buy' : 'sell';
    const qty = a.kind === 'meme' ? 2000 + rand() * 120000 : 1 + rand() * 90;
    const price = a.price * (0.97 + rand() * 0.06);
    return {
      ts: TAPE_END - i * (400 + Math.floor(rand() * 5200)),
      address: rand() > 0.5 ? TRADERS[Math.floor(rand() * TRADERS.length)].address : address(rand),
      side, qty, price, value: qty * price,
    };
  });
}

/** A price series for the asset page's chart. @param {string} symbol */
export function assetSeries(symbol) {
  const a = asset(symbol);
  if (!a) return [];
  const rand = rng((symbol.length * 7919 + symbol.charCodeAt(symbol.length - 1) * 31) % 233280);
  let p = a.price / (1 + a.change24h / 100);
  return Array.from({ length: 48 }, (_, i) => {
    p *= 1 + (rand() - 0.5) * (a.kind === 'meme' ? 0.06 : 0.012);
    return [TAPE_END - (48 - i) * 1800, p];
  });
}
