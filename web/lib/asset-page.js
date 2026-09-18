/**
 * The asset page (frame: asset-holders.dc.html).
 *
 * WHAT THE FRAME DREW THAT THIS BUILD DROPS OR CHANGES, and why:
 *
 *   - The 1D/1W/1M/1Y range chips over the price chart. assetDetail() returns exactly one
 *     series (a single window of price ticks) — the same reasoning lib/profile.js's own
 *     chart panel gives for dropping its range/metric toggle. A row of buttons that all draw
 *     the same curve is a control pretending to work, which the build contract rules out.
 *
 *   - The frame's own modal chrome (a "Assets / SYM" breadcrumb plus a theme toggle and a
 *     close [X], because the frame was drawn as a dialog inside a design tool). This page is
 *     a real route, not a dialog: the theme switch and the close button both belong to the
 *     shared top bar lib/chrome.js already mounts. What replaces the frame's breadcrumb strip
 *     here is a small ASSET SWITCHER (assets(), rendered as a <select>) — the task calls for
 *     one and the frame had nowhere to put it, so it takes the breadcrumb's old seat.
 *
 *   - "IN PROFIT" is drawn as an unsigned share of the tracked holders, on the neutral
 *     channel, where the frame coloured it var(--up) unconditionally. Rule 2 in the build
 *     contract reserves colour for a SIGNED figure; a share (like a win rate) stays neutral
 *     even when every one of its members happens to be positive this week.
 *
 *   - "PnL" on the holder table and the bubble tooltip is a signed DOLLAR figure, not the
 *     signed PERCENT the frame drew. assetHolders() hands back `pnl` in dollars (it is sized
 *     off `position`, itself a dollar figure) and no percent field — showing a "%" suffix on
 *     a number the payload never computed as one would be exactly the kind of plausible,
 *     untraceable figure the build contract calls out.
 *
 *   - The "HOLDERS" stat reads assets()'s own per-symbol `holders` COUNT (thousands, the
 *     whole tracked base) rather than the length of the holders array below it (at most 40,
 *     the deepest this mock's transfer index goes — see lib/mock.js's own comment on why a
 *     holder list can't be derived from the leaderboard). The two numbers are deliberately
 *     different and the panel headings say so, so nobody reads "40 shown" as "40 total".
 *
 * A LOCAL money() text formatter over the shared one in lib/format.js. money()/compact() both
 * assume a security-grade price ($20–$800) and round anything under a cent to "$0.00" — fatal
 * for a Pons memecoin at $0.00004. fmtPrice() below is the frame's own tiered formatter,
 * ported rather than merged into lib/format.js because this build does not touch shared files.
 * qty() is the same story: lib/format.js's compact() always prepends "$", so a token BALANCE
 * (not a dollar amount) would print as though it were one.
 */

import { assetDetail, assets, meta } from './data.js';
import { unwired } from './needs.js';
import { openProfile } from './profile.js';
import { areaChart } from './spark.js';
import { mountChrome, mountFoot } from './chrome.js';
import {
  node, el, compact, signed, shortAddr, ago, assetTile,
} from './format.js';

/**
 * @typedef {Object} Holder
 * @property {number} rank @property {string} address @property {boolean} onBoard
 * @property {number} sharePct @property {number} position @property {number} qty
 * @property {number} pnl @property {number} entry @property {number} sinceTs
 */
/**
 * @typedef {Object} Trade
 * @property {number} ts @property {string} address @property {string} side
 * @property {number} qty @property {number} price @property {number} value
 */
/**
 * @typedef {Object} AssetDetail
 * @property {string} symbol @property {string} name @property {string} kind
 * @property {number} price @property {number} change24h @property {number} volume24h
 * @property {number} traders @property {Holder[]} holders @property {Trade[]} trades
 * @property {[number, number][]} series
 */

const KIND_LABEL = /** @type {Record<string, string>} */ ({
  stock: 'Stock', etf: 'ETF', crypto: 'Crypto', stable: 'Stablecoin', meme: 'Memecoin',
});

/** The default symbol when the URL names none, or names one this mock does not have. */
const FALLBACK_SYMBOL = 'TSLA';

/**
 * A price at whatever precision it needs to say something. $342.18 and $0.00004182 are both
 * real prices on this board — one tiered formatter, ported from the design frame's own
 * (asset-holders.dc.html), rather than a fourth significant-figure special case bolted onto
 * lib/format.js's money(), which nothing else on the site needs.
 * @param {number} n
 */
function fmtPrice(n) {
  if (!Number.isFinite(n)) return '—';
  const s = n < 0 ? '−' : '';
  const a = Math.abs(n);
  if (a >= 100) return `${s}$${a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (a >= 1) return `${s}$${a.toFixed(2)}`;
  if (a >= 0.01) return `${s}$${a.toFixed(4)}`;
  if (a === 0) return `${s}$0`;
  return `${s}$${a.toPrecision(3)}`;
}

/** A token balance, unsigned and without a "$" — see the file header for why compact() won't do. @param {number} n */
function qty(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(n >= 10 ? 1 : 3);
}

/*
 * THE BUBBLE CLUSTER IS NOT BUILT HERE.
 *
 * The frame draws a packed cluster of holder bubbles, and the reference build in
 * design-refs/new-frontend/ has the whole of it: the spiral packer, the fit-to-box pass,
 * the per-bubble labels and the legend. None of it can run on a swap tape — a holder may
 * never have swapped — so shipping it would mean shipping lib/mock.js's invented wallets
 * with it. It comes back with the transfer index, out of that file, unchanged.
 */

const CLUSTER_FILTERS = /** @type {const} */ ([
  ['all', 'All'], ['profit', 'In profit'], ['underwater', 'Underwater'],
]);

const state = {
  symbol: FALLBACK_SYMBOL,
  /** @type {'all' | 'profit' | 'underwater'} */ clusterFilter: 'all',
  /** The raw ?symbol= the URL asked for, kept only so the notice can name it. Null once it
      resolved to something real, so the notice disappears the moment the symbol is valid. */
  /** @type {string | null} */ requested: null,
  /** @type {AssetDetail | null} */ detail: null,
  /** @type {{symbol: string, name: string | null, kind: string}[]} */ assetsList: [],
  tapeAnchor: 0,
  /** Bumped per load so a slow, superseded assetDetail() answer can never paint over a newer one. */
  seq: 0,
};

/** @type {HTMLElement} */ let mainEl;

/** @param {string} sym @param {boolean} pushUrl */
async function loadSymbol(sym, pushUrl) {
  const seq = (state.seq += 1);
  let detail = await assetDetail(sym).catch(() => null);
  let requested = null;
  if (!detail) {
    // An unknown or misspelled symbol reads as "showing the default instead" rather than a
    // blank page — the task calls for exactly that rather than an empty state.
    requested = sym;
    detail = await assetDetail(FALLBACK_SYMBOL).catch(() => null);
  }
  if (seq !== state.seq) return; // superseded by a newer loadSymbol() before this resolved
  state.detail = detail;
  state.symbol = detail?.symbol ?? FALLBACK_SYMBOL;
  state.requested = requested;
  if (pushUrl) {
    const url = `${location.pathname}?symbol=${encodeURIComponent(state.symbol)}`;
    history.pushState({ symbol: state.symbol }, '', url);
  }
  render();
}

/** @param {AssetDetail} d */
function buildCrumb(d) {
  const bar = node('div', 'as-crumb');
  const path = node('div', 'as-crumb-path');
  path.append(node('span', 'as-crumb-root', 'Assets'));
  path.append(node('span', 'as-crumb-sep', '/'));
  path.append(node('span', 'as-crumb-current', d.symbol));
  bar.append(path);
  if (state.requested) {
    bar.append(node('span', 'as-crumb-note',
      `"${state.requested.toUpperCase()}" isn't a symbol this build tracks — showing ${d.symbol} instead.`));
  }
  bar.append(node('div', 'spacer'));

  const switcher = node('label', 'as-switcher');
  switcher.append(node('span', 'sr-only', 'Switch asset'));
  const select = /** @type {HTMLSelectElement} */ (document.createElement('select'));
  select.setAttribute('aria-label', 'Switch asset');
  for (const a of state.assetsList) {
    const opt = document.createElement('option');
    opt.value = a.symbol;
    opt.textContent = a.name ? `${a.symbol} · ${a.name}` : a.symbol;
    if (a.symbol === d.symbol) opt.selected = true;
    select.append(opt);
  }
  select.onchange = () => loadSymbol(select.value, true);
  switcher.append(select);
  bar.append(switcher);
  return bar;
}

/** @param {AssetDetail} d */
function buildHeader(d) {
  const panel = node('section', 'as-head panel');

  const left = node('div', 'as-head-left');
  const top = node('div', 'as-head-top');
  top.append(assetTile(d.symbol, d.kind, 'asset-tile--lg'));
  const idCol = node('div', 'as-head-id');
  const line1 = node('div', 'as-head-line1');
  line1.append(node('span', 'as-head-sym', d.symbol));
  line1.append(node('span', `as-head-tag${d.kind === 'meme' ? ' as-head-tag--meme' : ''}`,
    KIND_LABEL[d.kind] ?? d.kind));
  idCol.append(line1);
  // No company names anywhere in the build — the tape carries tickers — so the line is the
  // chain alone rather than an invented expansion of the symbol.
  idCol.append(node('span', 'as-head-name', d.name ? `${d.name} · Robinhood Chain` : 'Robinhood Chain'));
  top.append(idCol, node('div', 'spacer'));

  const priceCol = node('div', 'as-head-price-col');
  priceCol.append(node('span', 'as-head-price mono', fmtPrice(d.price)));
  // WHAT THIS PRICE IS. The last trade the tape holds for this token, which is an execution
  // — someone's fill against a pool — and not a mid, a quote or a mark. On a thin token the
  // last trade can be hours old and away from where the pool would fill now, and nothing
  // here corrects for that. Saying so costs one line and stops the figure being read as a
  // market price.
  const priceNote = node('span', 'as-head-price-note', 'Last trade · not a mid or a quote');
  priceCol.append(priceNote);
  const chg = signed(d.change24h, 'as-head-chg', (x) => `${x.toFixed(2)}%`);
  chg.append(document.createTextNode(' today'));
  priceCol.append(chg);
  top.append(priceCol);
  left.append(top);

  /*
   * THREE OF THESE FOUR NEED THE TRANSFER INDEX, so three of them are not numbers.
   *
   * A holder may never have swapped — most holdings on this chain arrived by transfer,
   * issuance or bridge — so the swap tape cannot say who holds this token, how many of them
   * are up, or what they paid. The frames drew all three, and lib/mock.js still invents
   * them. What the tape CAN answer is the trading: the price of the last trade and the
   * volume behind it. So those two are measured and the rest name what they are waiting for.
   */
  const stats = [
    { label: '24H VOLUME', value: compact(d.volume24h) },
    { label: 'TRADERS', value: Number(d.traders ?? 0).toLocaleString('en-US') },
  ];
  const statsRow = node('div', 'as-stats');
  for (const stat of stats) {
    const cell = node('div', 'as-stat');
    cell.append(node('span', 'as-stat-label', stat.label));
    cell.append(node('span', 'as-stat-value mono', stat.value));
    statsRow.append(cell);
  }
  for (const key of /** @type {const} */ (['holders', 'inProfit', 'avgEntry'])) {
    statsRow.append(unwired(key));
  }
  left.append(statsRow);
  panel.append(left);

  const chartCol = node('div', 'as-head-chart');
  chartCol.append(node('span', 'as-chart-label', 'PRICE · LAST TRADE'));
  // areaChart() (lib/spark.js) always folds 0 into its y-domain — the right call for a PnL
  // curve, which is what it was built for, but wrong for a raw PRICE: TSLA's zero is nowhere
  // near $342, so forcing it into the range squashes every real tick into the top few pixels
  // and the fill reads as one solid block down to a baseline nobody asked about. Rebasing to
  // "change from this window's own opening tick" makes the zero areaChart insists on drawing
  // the window's OWN start price instead of an irrelevant absolute zero, so the headroom it
  // gives the line is exactly the size of the swing that actually happened — a flat week
  // stays a thin band near the middle, a volatile one still fills the box. Not touching
  // lib/spark.js: this is entirely a transform of what this page hands it.
  const base = d.series.length ? d.series[0][1] : 0;
  const rebasedSeries = /** @type {[number, number][]} */ (d.series.map(([ts, price]) => [ts, price - base]));
  chartCol.append(areaChart(rebasedSeries, { width: 520, height: 130 }));
  panel.append(chartCol);
  return panel;
}


const SVGNS = 'http://www.w3.org/2000/svg';
/** @param {string} tag @param {Record<string, string | number>} attrs */
function svgNode(tag, attrs = {}) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

/** The cluster's own coordinate space, scaled by the CSS to whatever box the panel gives it. */
const CLUSTER_W = 640;
const CLUSTER_H = 360;
/** A floor, or the tail of a top-heavy distribution is sub-pixel and unclickable. */
const MIN_R = 14;
const MAX_R = 62;

/**
 * Places every circle with no overlap by walking a fixed outward spiral from the centre and
 * taking the first spot that clears the walls and everything placed before it. Deterministic:
 * the same positions land in the same spots on every render, so two screenshots of the same
 * build are comparable. Ported from design-refs/new-frontend, which had the whole packer —
 * what it never had was a measured list to feed it.
 * @param {any[]} list biggest first
 */
function packBubbles(list, height = CLUSTER_H) {
  const max = Math.max(...list.map((h) => h.value), 1);
  /**
   * One pass at a given overall scale. Returns null if any circle could not be placed, so
   * the caller can try again smaller rather than stacking the leftovers in the middle.
   * @param {number} scale
   */
  const attempt = (scale) => {
    /** @type {{x: number, y: number, r: number, holder: any}[]} */
    const placed = [];
    for (const holder of list) {
      // Area, not radius: r ∝ √share, so the disc is proportional to the position rather
      // than the top wallet reading four times the one it is twice the size of.
      const r = (MIN_R + Math.sqrt(Math.max(0, holder.value) / max) * (MAX_R - MIN_R)) * scale;
      let spot = null;
      for (let step = 0; step < 6000 && !spot; step += 1) {
        const angle = step * 0.42;
        const dist = step * 0.55;
        const x = CLUSTER_W / 2 + Math.cos(angle) * dist;
        const y = height / 2 + Math.sin(angle) * dist * 0.62;
        if (x - r < 6 || x + r > CLUSTER_W - 6 || y - r < 6 || y + r > height - 6) continue;
        if (placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.r + r + 3)) spot = { x, y };
      }
      if (!spot) return null;
      placed.push({ x: spot.x, y: spot.y, r, holder });
    }
    return placed;
  };
  /*
   * SHRINK UNTIL THEY ALL FIT, rather than stacking the ones that did not.
   *
   * The reference build's packer gave up after 3,000 spiral steps and dropped the circle at
   * the centre, which is invisible when the set is top-heavy (its own mock always was) and
   * obvious here: measured positions in one token are often all within a factor of two, so a
   * dozen near-equal circles piled up in the middle and the outer ones were cut by the box.
   * Every circle scales by the same factor, so the area ratios — the one thing the cluster
   * has to preserve — survive the shrink.
   */
  for (const scale of [1, 0.9, 0.8, 0.7, 0.6, 0.5]) {
    const placed = attempt(scale);
    if (placed) return placed;
  }
  return attempt(0.4) ?? [];
}

/**
 * Shrinks and re-centres the packed set so its own bounding box lands inside the viewBox.
 * Every circle scales by the same factor, so the area ratios — the one thing the cluster has
 * to preserve — do not change.
 * @param {{x: number, y: number, r: number, holder: any}[]} placed
 * @param {number} w @param {number} h @param {number} [margin]
 */
function fitToBox(placed, w, h, margin = 10) {
  if (placed.length === 0) return placed;
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (const p of placed) {
    minX = Math.min(minX, p.x - p.r); maxX = Math.max(maxX, p.x + p.r);
    minY = Math.min(minY, p.y - p.r); maxY = Math.max(maxY, p.y + p.r);
  }
  const scale = Math.min((w - margin * 2) / Math.max(1, maxX - minX),
    (h - margin * 2) / Math.max(1, maxY - minY), 1);
  const cx = (minX + maxX) / 2; const cy = (minY + maxY) / 2;
  return placed.map((p) => ({
    x: w / 2 + (p.x - cx) * scale, y: h / 2 + (p.y - cy) * scale, r: p.r * scale, holder: p.holder,
  }));
}

/**
 * One bubble. Colour is the sign of what the position is worth against what it cost, and
 * nothing else; a wallet that also ranks on the leaderboard gets a heavier neutral ring,
 * which is a second fact rather than a stronger opinion about the first.
 * @param {{x: number, y: number, r: number, holder: any}} p
 * @param {'all' | 'profit' | 'underwater'} filter
 */
function buildBubble(p, filter) {
  const h = p.holder;
  const known = Number.isFinite(h.pnl_pct);
  const up = known && h.pnl_pct >= 0;
  const dim = known && ((filter === 'profit' && !up) || (filter === 'underwater' && up));
  const tone = !known ? 'var(--muted)' : up ? 'var(--up)' : 'var(--down)';
  const say = `${h.ranked ? 'Leaderboard trader ' : 'Wallet '}${shortAddr(h.address)}: `
    + `${qty(h.units)} ${state.symbol} unsold, worth ${compact(h.value)} at the last trade`
    + (known ? `, ${h.pnl_pct >= 0 ? 'up' : 'down'} ${Math.abs(h.pnl_pct).toFixed(1)}% on what it paid.` : '.');

  const g = svgNode('g', {
    class: 'as-bubble', tabindex: '0', role: 'button', 'aria-label': say, opacity: dim ? 0.18 : 1,
  });
  const title = svgNode('title', {});
  title.textContent = say;
  g.append(title);
  g.append(svgNode('circle', {
    cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: p.r.toFixed(1),
    fill: `color-mix(in srgb, ${tone} ${h.ranked ? 30 : 16}%, var(--surface))`,
    stroke: h.ranked ? 'var(--fg)' : tone, 'stroke-width': h.ranked ? 2.5 : 1.5,
  }));
  // 40, not the reference's 34: an 11px elided address is ~74px wide, and a 34px radius is
  // 68px across — every label on a circle that size hung over its own edge.
  if (p.r >= 40) {
    const label = svgNode('text', {
      x: p.x.toFixed(1), y: (p.y - 5).toFixed(1), 'text-anchor': 'middle', class: 'as-bubble-label',
    });
    label.textContent = shortAddr(h.address);
    g.append(label);
  }
  if (p.r >= 20 && known) {
    const pctEl = svgNode('text', {
      x: p.x.toFixed(1), y: (p.r >= 40 ? p.y + 11 : p.y + 3.5).toFixed(1),
      'text-anchor': 'middle', class: `as-bubble-pct ${up ? 'up' : 'down'}`,
    });
    /*
     * All three channels inside the circle too: the glyph, the sign and the colour. A figure
     * that keeps two of the three on one surface and three on another is a rule nobody can
     * rely on, and the glyph is the channel a colour-blind reader is left with. It is a
     * <tspan class="mark">, the same element the HTML figures use, so the same check covers
     * both — an SVG figure is not a place where the rule quietly stops applying.
     */
    const mag = Math.abs(h.pnl_pct);
    const mark = svgNode('tspan', { class: 'mark' });
    mark.textContent = up ? '▲' : '▼';
    pctEl.append(mark, document.createTextNode(
      `${up ? '+' : '−'}${mag < 0.1 ? mag.toFixed(2) : mag.toFixed(1)}%`));
    g.append(pctEl);
  }
  const open = () => openProfile(h.address, /** @type {any} */ (g));
  g.addEventListener('click', open);
  g.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return g;
}

/**
 * The position side of the page: what the swap tape can say about who is holding, and what
 * it cannot.
 *
 * WHAT THE BUBBLES ARE. Per wallet: units of this token bought on-chain minus units sold,
 * with a FIFO cost for the units still unsold, computed by the build over the same window
 * everything else on this page comes from. A bubble's area is what that position is worth at
 * the last trade; its tint is that value against what the wallet paid; a heavier ring says
 * the wallet also ranks on the leaderboard.
 *
 * WHAT THEY ARE NOT. Holders. A wallet can hold units that were transferred, bridged or
 * issued to it, and a swap tape cannot see any of that — so this is a floor on what these
 * wallets hold, and there are holders it cannot see at all. A wallet whose on-chain selling
 * exceeded its on-chain buying is not drawn: its supply came from somewhere invisible here,
 * and a negative bubble would be a claim about a short position nobody measured.
 *
 * That is also why the header's HOLDERS, HOLDERS IN PROFIT and AVG ENTRY stay unwired: each
 * is a statement about everyone who holds the token, which needs an ERC-20 transfer index.
 * This panel is careful to say "bought on-chain" everywhere it would be easier to say "holds".
 * @param {AssetDetail} d
 */
function buildHolderPanels(d) {
  const positions = /** @type {any[]} */ (/** @type {any} */ (d).positions ?? []);
  const cluster = node('section', 'as-cluster panel');
  const head = node('div', 'as-cluster-head');
  const headText = node('div', 'as-cluster-headtext');
  headText.append(node('h2', undefined, 'Position cluster'));
  headText.append(node('p', undefined,
    `Each bubble is a wallet that bought ${d.symbol} on-chain, sized by what it has not sold. `
    + 'Units transferred or bridged in are invisible to a swap tape, so this is a floor on '
    + 'what these wallets hold and not a holder list.'));
  head.append(headText);

  const seg = node('div', 'seg as-cluster-filter');
  for (const [id, label] of CLUSTER_FILTERS) {
    const b = /** @type {HTMLButtonElement} */ (node('button', undefined, label));
    b.type = 'button';
    b.setAttribute('aria-pressed', String(state.clusterFilter === id));
    b.disabled = positions.length === 0;
    if (positions.length === 0) b.title = 'Needs the transfer index';
    b.onclick = () => { state.clusterFilter = id; render(); };
    seg.append(b);
  }
  head.append(seg);
  cluster.append(head);

  const stage = node('div', 'as-cluster-stage');
  if (positions.length === 0) {
    // A store built before the positions landed: the panel keeps the frame's shape and says
    // what it is waiting for rather than drawing an empty box.
    const ghosts = node('div', 'as-cluster-ghosts');
    ghosts.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 18; i += 1) ghosts.append(node('span', 'as-ghost'));
    stage.append(ghosts, unwired('holders'));
  } else {
    const svg = svgNode('svg', {
      viewBox: `0 0 ${CLUSTER_W} ${CLUSTER_H}`, width: '100%', height: '100%',
      preserveAspectRatio: 'xMidYMid meet', class: 'as-cluster-svg',
    });
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label',
      `${positions.length} wallets holding ${d.symbol} from on-chain buys, sized by position`);
    // Packed and fitted into the box ABOVE the legend, so a bubble never sits under it.
    const LEGEND = 46;
    for (const p of fitToBox(packBubbles(positions, CLUSTER_H - LEGEND), CLUSTER_W, CLUSTER_H - LEGEND)) {
      svg.append(buildBubble(p, state.clusterFilter));
    }
    stage.append(svg);

    const legend = node('div', 'as-legend');
    for (const [cls, label] of [['up', 'Up on cost'], ['down', 'Down on cost'],
      ['board', 'Leaderboard trader']]) {
      const item = node('span', 'as-legend-item');
      item.append(node('span', `as-legend-swatch as-legend-swatch--${cls}`),
        document.createTextNode(label));
      legend.append(item);
    }
    stage.append(legend);
  }
  cluster.append(stage);

  const holders = node('section', 'as-holders panel');
  const hHead = node('div', 'as-holders-head');
  hHead.append(node('h2', undefined, 'Largest positions'));
  hHead.append(node('span', 'as-holders-count',
    positions.length ? `${positions.length} shown` : 'Ranked by position'));
  holders.append(hHead);
  const thead = node('div', 'as-thead');
  thead.append(node('span', undefined, '#'), node('span', undefined, 'Wallet'),
    node('span', 'right', 'Position'), node('span', 'right', 'vs cost'));
  holders.append(thead);

  const body = node('div', 'as-tbody');
  if (positions.length === 0) {
    body.append(unwired('holders'));
    const rows = node('div', 'as-holder-ghosts');
    rows.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 8; i += 1) {
      const r = node('div', 'as-holder-ghost');
      r.append(node('span', 'as-ghost-bar as-ghost-bar--n'), node('span', 'as-ghost-bar as-ghost-bar--w'),
        node('span', 'as-ghost-bar as-ghost-bar--p'), node('span', 'as-ghost-bar as-ghost-bar--r'));
      rows.append(r);
    }
    body.append(rows);
  } else {
    positions.forEach((h, i) => {
      const row = /** @type {HTMLButtonElement} */ (node('button', 'as-trow'));
      row.type = 'button';
      row.setAttribute('aria-label', `Open ${shortAddr(h.address)}`);
      row.onclick = () => openProfile(h.address, row);
      row.append(node('span', 'as-td mono', String(i + 1)));
      const who = node('span', 'as-td as-wallet');
      who.append(node('span', 'avatar mono', h.address.slice(2, 4).toUpperCase()));
      who.append(node('span', 'mono', shortAddr(h.address)));
      if (h.ranked) who.append(node('span', 'as-lb', 'LB'));
      row.append(who);
      row.append(node('span', 'as-td right mono', compact(h.value)));
      // A percent against cost is a signed figure and keeps all three channels; a position
      // with no cost left to compare against prints a dash, not a zero.
      const vs = node('span', 'as-td right');
      if (Number.isFinite(h.pnl_pct)) {
        vs.append(signed(h.pnl_pct, 'mono',
          (/** @type {number} */ n) => `${Math.abs(n) < 0.1 ? n.toFixed(2) : n.toFixed(1)}%`));
      } else {
        vs.append(node('span', 'mono', '—'));
      }
      row.append(vs);
      body.append(row);
    });
  }
  holders.append(body);

  return [cluster, holders];
}

/** @param {AssetDetail} d */
function buildTradesPanel(d) {
  const panel = node('section', 'as-trades panel');
  const head = node('div', 'as-trades-head');
  head.append(node('h2', undefined, `Recent ${d.symbol} trades`));
  // NOT "Live from Robinhood Chain". These trades come from the last build of the swap
  // tape, which is minutes old and fixed until the next cycle — calling that live would be
  // a claim about freshness the page cannot keep. The footer names the build it is showing.
  const live = node('span', 'as-live');
  live.append(document.createTextNode('From the swap tape, as of the current build'));
  head.append(live);
  panel.append(head);

  const thead = node('div', 'as-trades-thead');
  thead.append(node('span', undefined, 'Time'), node('span', undefined, 'Wallet'),
    node('span', undefined, 'Side'), node('span', 'right', 'Amount'),
    node('span', 'right', 'Price'), node('span', 'right', 'Value'));
  panel.append(thead);

  const body = node('div', 'as-trades-body');
  for (const t of d.trades.slice(0, 14)) {
    const row = node('div', 'as-trade-row');
    row.append(node('span', 'as-td mono', ago(t.ts, state.tapeAnchor)));
    const walletCell = node('span', 'as-td');
    const walletBtn = /** @type {HTMLButtonElement} */ (node('button', 'as-trade-wallet', shortAddr(t.address)));
    walletBtn.type = 'button';
    walletBtn.setAttribute('aria-label', `Open profile for ${shortAddr(t.address)}`);
    walletBtn.onclick = () => openProfile(t.address, walletBtn);
    walletCell.append(walletBtn);
    row.append(walletCell);
    const sideCell = node('span', 'as-td');
    sideCell.append(node('span', 'as-side', t.side.charAt(0).toUpperCase() + t.side.slice(1)));
    row.append(sideCell);
    row.append(node('span', 'as-td right mono', `${qty(t.qty)} ${d.symbol}`));
    row.append(node('span', 'as-td right mono', fmtPrice(t.price)));
    row.append(node('span', 'as-td right mono', compact(t.value)));
    body.append(row);
  }
  panel.append(body);
  return panel;
}

/** Rebuilds the whole main from the current state — cheap enough at this data size, and it
    means a symbol switch never has stale panels left over from the previous asset. */
function render() {
  if (!mainEl) return;
  // No detail and no list: the build has no asset data yet, which happens for a cycle or
  // two after a deploy. Say that, rather than leaving the page blank — a blank page reads
  // as broken, and this is a state with a known end.
  if (!state.detail) {
    mainEl.replaceChildren();
    const box = node('section', 'as-head panel');
    const inner = node('div', 'as-head-left');
    inner.append(node('h1', 'as-head-sym', 'No asset data in this build'));
    inner.append(node('p', 'as-head-name',
      'The asset list and the per-asset tape are written by the build cycle, which runs '
      + 'every fifteen minutes. This store predates them; the next cycle fills it in. The '
      + 'leaderboard and every address page work in the meantime.'));
    box.append(inner);
    mainEl.append(box);
    return;
  }
  const d = state.detail;
  mainEl.replaceChildren();
  mainEl.append(buildCrumb(d));

  const body = node('div', 'as-body');
  body.append(buildHeader(d));
  const mid = node('div', 'as-mid');
  mid.append(...buildHolderPanels(d));
  body.append(mid);
  body.append(buildTradesPanel(d));
  mainEl.append(body);
}

/**
 * chrome.js declares its `onSearch` hook with a plain `string` kind, so this takes one too and
 * narrows on the comparison rather than making the mount site cast.
 * @param {string} kind @param {string} id
 */
function onSearchPick(kind, id) {
  if (kind === 'trader') openProfile(id);
  else loadSymbol(id.toUpperCase(), true);
}

async function init() {
  mountChrome(el('chrome'), { current: 'markets', onSearch: onSearchPick });
  mainEl = el('asset-main');
  if (!mainEl) return;

  let m;
  try {
    m = await meta();
  } catch {
    m = { sample: false, builtAt: Math.floor(Date.now() / 1000) };
  }
  // ago() measures from the tape's own end, never the wall clock — see lib/format.js's own
  // note on why a fixed historical window would otherwise read as "the same age" forever.
  state.tapeAnchor = m.builtAt ?? Math.floor(Date.now() / 1000);
  mountFoot(el('foot'), m);

  try {
    state.assetsList = await assets();
  } catch {
    // The switcher just offers nothing to switch to; the current asset still renders fine off
    // assetDetail() alone.
    state.assetsList = [];
  }

  const initial = new URLSearchParams(location.search).get('symbol')?.trim() || FALLBACK_SYMBOL;
  await loadSymbol(initial.toUpperCase(), false);

  // Back/forward through switched assets should not be a dead end.
  globalThis.addEventListener('popstate', () => {
    const sym = new URLSearchParams(location.search).get('symbol')?.trim() || FALLBACK_SYMBOL;
    loadSymbol(sym.toUpperCase(), false);
  });
}

init();
