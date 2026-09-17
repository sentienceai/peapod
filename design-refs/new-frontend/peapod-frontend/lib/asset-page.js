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
import { openProfile } from './profile.js';
import { areaChart } from './spark.js';
import { mountChrome, mountFoot } from './chrome.js';
import {
  node, el, compact, pct, signed, signedMoneyText, shortAddr, ago, assetTile,
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

const SVGNS = 'http://www.w3.org/2000/svg';
/** @param {string} tag @param {Record<string, string | number>} attrs */
function svgNode(tag, attrs = {}) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

/** The cluster's own coordinate space — arbitrary units scaled to whatever box the CSS gives
    the <svg>, so the same packing serves 1440px and a phone without a second computation. */
const CLUSTER_W = 640;
const CLUSTER_H = 360;
/** Top-heavy holder lists need a floor radius or the tail becomes sub-pixel and unclickable;
    74px² of floor spent on a wallet holding 0.1% is the trade-off, same one the frame made. */
const MIN_R = 14;
const MAX_R = 62;
/** How many of the ranked holders get a bubble. The task's own number: "top ~28". */
const CLUSTER_N = 28;
/** How many ranked rows the table lists below the cluster. */
const TABLE_N = 20;

/**
 * Places every holder's circle with no overlap, by walking a fixed outward spiral from the
 * box's centre and taking the first spot that clears the walls and every circle placed before
 * it. DELIBERATELY NOT A RELAXATION / FORCE SIM: with ~28 circles, one deterministic pass is
 * enough to pack them, and it means the SAME 28 holders land in the SAME spots on every
 * render — a mock rebuild is comparable to the last screenshot rather than a fresh shuffle.
 * @param {Holder[]} holders ranked, biggest position first
 */
function packBubbles(holders) {
  const maxPos = Math.max(...holders.map((h) => h.position), 1);
  /** @type {{x: number, y: number, r: number, holder: Holder}[]} */
  const placed = [];
  for (const holder of holders) {
    // Area, not radius, carries the size: r ∝ sqrt(share) makes the DISC proportional to
    // position, so the top holder does not read four times the wallet the sqrt would give a
    // radius-linear scale. MIN_R keeps the smallest disc large enough to see, read and click.
    const r = MIN_R + Math.sqrt(Math.max(0, holder.position) / maxPos) * (MAX_R - MIN_R);
    let spot = null;
    for (let step = 0; step < 3000 && !spot; step += 1) {
      const angle = step * 0.42;
      const dist = step * 0.85;
      const x = CLUSTER_W / 2 + Math.cos(angle) * dist;
      const y = CLUSTER_H / 2 + Math.sin(angle) * dist * 0.62; // squashed to the box's aspect
      if (x - r < 6 || x + r > CLUSTER_W - 6 || y - r < 6 || y + r > CLUSTER_H - 6) continue;
      if (placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.r + r + 3)) spot = { x, y };
    }
    // A fallback centre stack should never actually trigger at CLUSTER_N=28 in this box — it
    // exists so a future bump to that constant fails as an overlap, not a thrown exception.
    placed.push({ x: spot?.x ?? CLUSTER_W / 2, y: spot?.y ?? CLUSTER_H / 2, r, holder });
  }
  return placed;
}

/**
 * Scales and re-centres the packed set so its own bounding box — not the box packBubbles()
 * AIMED for — lands inside the viewBox with `margin` to spare. packBubbles()'s spiral already
 * tries to respect CLUSTER_W/H itself, but a distribution it cannot pack tightly (a lot of
 * near-equal small circles, or a fallback centre-stack) can still walk its bounding box past
 * the edge; this step makes "nothing is cut" true by construction instead of by hoping the
 * spiral's own margins were generous enough. Every circle scales by the SAME factor, so the
 * area ratios between holders — the one thing this cluster is required to preserve — do not
 * change; only the whole arrangement's overall size and position do.
 * @param {{x: number, y: number, r: number, holder: Holder}[]} placed
 * @param {number} w @param {number} h @param {number} [margin]
 */
function fitToBox(placed, w, h, margin = 10) {
  if (placed.length === 0) return placed;
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (const p of placed) {
    minX = Math.min(minX, p.x - p.r); maxX = Math.max(maxX, p.x + p.r);
    minY = Math.min(minY, p.y - p.r); maxY = Math.max(maxY, p.y + p.r);
  }
  const boxW = Math.max(1, maxX - minX);
  const boxH = Math.max(1, maxY - minY);
  // Only ever shrinks (min(..., 1)) — a packed set that already fits should not be blown up
  // to fill empty space, since that would make bubbles read bigger than their area earns them.
  const scale = Math.min((w - margin * 2) / boxW, (h - margin * 2) / boxH, 1);
  const cx = (minX + maxX) / 2; const cy = (minY + maxY) / 2;
  return placed.map((p) => ({
    x: w / 2 + (p.x - cx) * scale, y: h / 2 + (p.y - cy) * scale, r: p.r * scale, holder: p.holder,
  }));
}

/**
 * One bubble: a circle, an optional address label, an optional share label, a <title> for the
 * mouse and an aria-label for everyone else — all built off the same sentence. What TEXT it
 * shows is gated on its own final radius, not on which "size tier" it was drawn at, so a
 * bubble the fit-to-box scale above shrank never carries a label wider than itself:
 *   r ≥ 34  — address AND its share, on two lines (an 11px address needs roughly this to
 *             clear its own circle; the share line needs another line of height under it).
 *   r ≥ 22  — the share alone, centred (a short "8.3%" clears a much smaller disc).
 *   smaller — nothing drawn; the wallet is still reachable and still names itself in the
 *             <title>/aria-label below, which is the one place size never gates the truth.
 * @param {{x: number, y: number, r: number, holder: Holder}} p
 * @param {'all' | 'profit' | 'underwater'} filter
 */
function buildBubble(p, filter) {
  const h = p.holder;
  const up = h.pnl >= 0;
  const dim = (filter === 'profit' && !up) || (filter === 'underwater' && up);
  const tone = up ? 'var(--up)' : 'var(--down)';

  const say = `${h.onBoard ? 'Leaderboard trader ' : 'Wallet '}${shortAddr(h.address)}: `
    + `${compact(h.position)} position, ${pct(h.sharePct, 1)} of tracked holders, `
    + `PnL ${signedMoneyText(h.pnl)}.`;

  const g = svgNode('g', {
    class: 'as-bubble', tabindex: '0', role: 'button', 'aria-label': say, opacity: dim ? 0.18 : 1,
  });
  const title = svgNode('title', {});
  title.textContent = say;
  g.append(title);
  g.append(svgNode('circle', {
    cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: p.r.toFixed(1),
    // Colour tints by PnL sign only, never by size — size is already the disc's area. A
    // leaderboard trader (onBoard) gets a heavier, neutral-ink ring instead of a toned one:
    // that ring is a SEPARATE fact (this address also trades enough to rank), not a stronger
    // opinion about the same PnL sign, so it does not compete with the tone for the eye.
    fill: `color-mix(in srgb, ${tone} ${h.onBoard ? 30 : 16}%, var(--surface))`,
    stroke: h.onBoard ? 'var(--fg)' : tone, 'stroke-width': h.onBoard ? 2.5 : 1.5,
  }));
  if (p.r >= 34) {
    const label = svgNode('text', {
      x: p.x.toFixed(1), y: (p.y - 5).toFixed(1), 'text-anchor': 'middle', class: 'as-bubble-label',
    });
    label.textContent = shortAddr(h.address);
    g.append(label);
    const shareEl = svgNode('text', {
      x: p.x.toFixed(1), y: (p.y + 11).toFixed(1),
      'text-anchor': 'middle', class: `as-bubble-pct ${up ? 'up' : 'down'}`,
    });
    shareEl.textContent = pct(h.sharePct, 1);
    g.append(shareEl);
  } else if (p.r >= 22) {
    const shareEl = svgNode('text', {
      x: p.x.toFixed(1), y: (p.y + 3.5).toFixed(1),
      'text-anchor': 'middle', class: `as-bubble-pct ${up ? 'up' : 'down'}`,
    });
    shareEl.textContent = pct(h.sharePct, 1);
    g.append(shareEl);
  }
  const open = () => openProfile(h.address, /** @type {any} */ (g));
  g.addEventListener('click', open);
  g.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return g;
}

/**
 * The cluster's <svg>, rebuilt whenever the holder set or the profit filter changes.
 * @param {Holder[]} holders full ranked list (only the top CLUSTER_N get a bubble)
 * @param {'all' | 'profit' | 'underwater'} filter
 */
function buildClusterSvg(holders, filter) {
  const top = holders.slice(0, CLUSTER_N);
  const svg = svgNode('svg', {
    viewBox: `0 0 ${CLUSTER_W} ${CLUSTER_H}`, width: '100%', height: '100%',
    preserveAspectRatio: 'xMidYMid meet', class: 'as-cluster-svg',
  });
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Holder cluster, ${top.length} wallets sized by position`);
  for (const p of fitToBox(packBubbles(top), CLUSTER_W, CLUSTER_H)) svg.append(buildBubble(p, filter));
  return svg;
}

/** The legend under the cluster: what a wash, a ring and a heavier ring each mean. */
function buildLegend() {
  const legend = node('div', 'as-legend');
  /** @param {'up' | 'down'} tone @param {string} label */
  const swatchItem = (tone, label) => {
    const item = node('span', 'as-legend-item');
    item.append(node('span', `as-legend-swatch as-legend-swatch--${tone}`));
    item.append(document.createTextNode(label));
    return item;
  };
  legend.append(swatchItem('up', 'In profit'));
  legend.append(swatchItem('down', 'Underwater'));
  const board = node('span', 'as-legend-item');
  board.append(node('span', 'as-legend-swatch as-legend-swatch--board'));
  board.append(document.createTextNode('Leaderboard trader'));
  legend.append(board);
  return legend;
}

const CLUSTER_FILTERS = /** @type {const} */ ([
  ['all', 'All'], ['profit', 'In profit'], ['underwater', 'Underwater'],
]);

/** Everything this module needs to keep live between a filter click and a symbol switch. */
const state = {
  symbol: FALLBACK_SYMBOL,
  /** The raw ?symbol= the URL asked for, kept only so the notice can name it. Null once it
      resolved to something real, so the notice disappears the moment the symbol is valid. */
  /** @type {string | null} */ requested: null,
  /** @type {AssetDetail | null} */ detail: null,
  /** @type {{symbol: string, name: string, kind: string, holders: number}[]} */ assetsList: [],
  /** @type {'all' | 'profit' | 'underwater'} */ clusterFilter: 'all',
  tapeAnchor: 0,
  /** Bumped per load so a slow, superseded assetDetail() answer can never paint over a newer one. */
  seq: 0,
};

/** @type {HTMLElement} */ let mainEl;
/** @type {HTMLElement} */ let stageEl;
/** @type {HTMLElement} */ let filtersEl;

/** Repaints only the bubble field and its filter chips — a symbol switch rebuilds everything
    below it, but toggling "In profit" should not re-flow the whole page around it. */
function paintCluster() {
  if (!stageEl || !state.detail) return;
  const old = stageEl.querySelector('.as-cluster-svg');
  if (old) old.remove();
  stageEl.prepend(buildClusterSvg(state.detail.holders, state.clusterFilter));
  if (filtersEl) {
    for (const btn of Array.from(filtersEl.children)) {
      if (btn instanceof HTMLButtonElement) {
        btn.setAttribute('aria-pressed', String(btn.dataset.filter === state.clusterFilter));
      }
    }
  }
}

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
  state.clusterFilter = 'all';
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
    opt.textContent = `${a.symbol} · ${a.name}`;
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
  idCol.append(node('span', 'as-head-name', `${d.name} · Robinhood Chain`));
  top.append(idCol, node('div', 'spacer'));

  const priceCol = node('div', 'as-head-price-col');
  priceCol.append(node('span', 'as-head-price mono', fmtPrice(d.price)));
  const chg = signed(d.change24h, 'as-head-chg', (x) => `${x.toFixed(2)}%`);
  chg.append(document.createTextNode(' today'));
  priceCol.append(chg);
  top.append(priceCol);
  left.append(top);

  // Total holders is assets()'s per-symbol count (thousands); the array below only ever
  // reaches TABLE_N/CLUSTER_N deep, per the mock's own transfer-index limit (see file header).
  const totalHolders = state.assetsList.find((a) => a.symbol === d.symbol)?.holders
    ?? d.holders.length;
  const shown = d.holders.length;
  const inProfit = shown ? (d.holders.filter((h) => h.pnl >= 0).length / shown) * 100 : 0;
  const qtySum = d.holders.reduce((s, h) => s + h.qty, 0);
  const avgEntry = qtySum ? d.holders.reduce((s, h) => s + h.entry * h.qty, 0) / qtySum : d.price;
  const stats = [
    { label: 'HOLDERS', value: totalHolders.toLocaleString('en-US') },
    { label: '24H VOLUME', value: compact(d.volume24h) },
    // A share stays on the neutral channel (rule 2) — colour is spent on signed figures only,
    // and "how many of the wallets we can see are up" is a share, not a gain or a loss.
    { label: 'IN PROFIT', value: `${Math.round(inProfit)}%` },
    { label: 'AVG ENTRY', value: fmtPrice(avgEntry) },
  ];
  const statsRow = node('div', 'as-stats');
  for (const s of stats) {
    const cell = node('div', 'as-stat');
    cell.append(node('span', 'as-stat-label', s.label));
    cell.append(node('span', 'as-stat-value mono', s.value));
    statsRow.append(cell);
  }
  left.append(statsRow);
  panel.append(left);

  const chartCol = node('div', 'as-head-chart');
  chartCol.append(node('span', 'as-chart-label', 'PRICE'));
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

/** @param {AssetDetail} d */
function buildClusterPanel(d) {
  const panel = node('section', 'as-cluster panel');
  const head = node('div', 'as-cluster-head');
  const headText = node('div', 'as-cluster-headtext');
  headText.append(node('h2', undefined, 'Holder cluster'));
  headText.append(node('p', undefined,
    `Each bubble is a wallet holding ${d.symbol}. Bigger bubble, bigger position. `
    + 'Click one to open the wallet.'));
  head.append(headText);

  filtersEl = node('div', 'seg as-filters');
  filtersEl.setAttribute('role', 'group');
  filtersEl.setAttribute('aria-label', `Filter the ${d.symbol} holder cluster`);
  for (const [id, label] of CLUSTER_FILTERS) {
    const btn = /** @type {HTMLButtonElement} */ (node('button', undefined, label));
    btn.type = 'button';
    btn.dataset.filter = id;
    btn.setAttribute('aria-pressed', String(state.clusterFilter === id));
    btn.onclick = () => { state.clusterFilter = id; paintCluster(); };
    filtersEl.append(btn);
  }
  head.append(filtersEl);
  panel.append(head);

  stageEl = node('div', 'as-cluster-stage');
  stageEl.append(buildClusterSvg(d.holders, state.clusterFilter));
  stageEl.append(buildLegend());
  panel.append(stageEl);
  return panel;
}

/** @param {AssetDetail} d */
function buildHoldersPanel(d) {
  const panel = node('section', 'as-holders panel');
  const head = node('div', 'as-holders-head');
  head.append(node('h2', undefined, 'Top holders'));
  head.append(node('span', 'as-holders-count', `${Math.min(TABLE_N, d.holders.length)} shown`));
  panel.append(head);

  const thead = node('div', 'as-thead');
  thead.append(node('span', undefined, '#'), node('span', undefined, 'Wallet'),
    node('span', 'right', 'Position'), node('span', 'right', 'PnL'));
  panel.append(thead);

  const rows = node('div', 'as-tbody');
  for (const h of d.holders.slice(0, TABLE_N)) {
    const row = /** @type {HTMLButtonElement} */ (node('button', 'as-trow'));
    row.type = 'button';
    // The FULL address, never the shortened form, in both the row's aria-label and the
    // visible address span's own title — a screen reader or a hover tooltip should always be
    // able to say the whole thing even when the printed text on the row is not.
    row.setAttribute('aria-label', `Open profile for ${h.address}, ${compact(h.position)} position`);
    row.onclick = () => openProfile(h.address, row);

    row.append(node('span', 'as-td mono', String(h.rank)));
    const wallet = node('span', 'as-td as-wallet');
    wallet.append(node('span', 'avatar', h.address.slice(2, 4).toUpperCase()));
    const nameCol = node('span', 'as-wallet-name');
    // .as-wallet-addr carries `mono` (rule 4: an address is a figure, not prose) AND its own
    // flex-basis in styles/asset.css, so it — not the LEADERBOARD mark beside it — is the
    // thing that shrinks first when the column is tight. The mark's text stays "LB" rather
    // than the full word for the same reason: a reader needs BOTH which wallet this is and
    // that it is on the board, and a badge wide enough to win a fight with the address for
    // space would cost the page the one fact (which wallet) nothing else on the row repeats.
    const addrEl = node('span', 'as-wallet-addr mono', shortAddr(h.address));
    addrEl.title = h.address;
    nameCol.append(addrEl);
    if (h.onBoard) {
      const badge = node('span', 'as-badge', 'LB');
      badge.title = 'Leaderboard trader';
      badge.setAttribute('aria-label', 'Leaderboard trader');
      nameCol.append(badge);
    }
    wallet.append(nameCol);
    row.append(wallet);
    row.append(node('span', 'as-td right mono', compact(h.position)));
    row.append(signed(h.pnl, 'as-td right mono', compact));
    rows.append(row);
  }
  panel.append(rows);
  return panel;
}

/** @param {AssetDetail} d */
function buildTradesPanel(d) {
  const panel = node('section', 'as-trades panel');
  const head = node('div', 'as-trades-head');
  head.append(node('h2', undefined, `Recent ${d.symbol} trades`));
  const live = node('span', 'as-live');
  live.append(node('span', 'as-live-dot'));
  live.append(document.createTextNode('Live from Robinhood Chain'));
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
  if (!mainEl || !state.detail) return;
  const d = state.detail;
  mainEl.replaceChildren();
  mainEl.append(buildCrumb(d));

  const body = node('div', 'as-body');
  body.append(buildHeader(d));
  const mid = node('div', 'as-mid');
  mid.append(buildClusterPanel(d), buildHoldersPanel(d));
  body.append(mid);
  body.append(buildTradesPanel(d));
  mainEl.append(body);
}

/** @param {'asset' | 'trader'} kind @param {string} id */
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
