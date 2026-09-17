/**
 * The LP calculator.
 *
 * Answers one question — what would this position have done against simply holding the
 * two tokens — and answers it as a DISTRIBUTION across every historical window of the
 * chosen length. A single median would be the point estimate this tool exists to replace:
 * on these pools the spread between the fifth and ninety-fifth percentile is the finding,
 * not the middle.
 *
 * Everything is evaluated in the browser from precomputed windows. The IL term is
 * size-independent and comes straight from the window; only fees move with size, through
 * the kernel in lib/kernel.js.
 */

import { histogram, netVsHodlPct, quantile } from '../lib/kernel.js';
import { compact, money, pct, shortAddress, stamp } from '../lib/format.js';
import { subsidyNote } from '../lib/findings.js';

/** @param {string} id */
const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
/** @param {string} id */
const input = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));
/** @param {string} id */
const select = (id) => /** @type {HTMLSelectElement} */ (document.getElementById(id));

/** @param {string} tag @param {string} [cls] @param {string} [text] */
function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const [index, meta, depth, poolMeta] = await Promise.all([
  fetch('../../web/data/windows.json').then((r) => r.json()),
  fetch('../../web/data/meta.json').then((r) => r.json()),
  fetch('../../web/data/depth.json').then((r) => r.json()),
  fetch('../../web/data/pools.json').then((r) => r.json()),
]);

const prov = meta.provenance;
const columns = index.columns;
/** @type {Map<string, any>} */
const poolInfo = new Map(poolMeta.pools.map((/** @type {any} */ p) => [p.pool_id, p]));
/** @type {Map<string, any>} */
const depthByPool = new Map(depth.pools.map((/** @type {any} */ p) => [p.pool_id, p]));
/** @type {Map<string, any>} */
const kernelCache = new Map();

/** Widths as percentages, in the order the index declares them. `full` has no bound. */
const widthPct = index.widths.map((/** @type {string} */ _name, /** @type {number} */ i) =>
  index.width_half_pct[i] === null ? null : index.width_half_pct[i] * 100);

/* --------------------------------------------------------------- controls */

const poolsWithWindows = [...new Set(columns.pool_id)].map((i) => index.pools[/** @type {number} */ (i)]);
const ordered = depth.pools
  .filter((/** @type {any} */ p) => poolsWithWindows.includes(p.pool_id))
  .map((/** @type {any} */ p) => p.pool_id);

function buildPoolSelect() {
  const sel = select('pool');
  sel.replaceChildren();
  for (const id of ordered) {
    const d = depthByPool.get(id);
    const option = document.createElement('option');
    option.value = id;
    option.textContent = `${d.ticker}  ${shortAddress(id)}  ${compact(d.depth_executable)} depth`;
    sel.append(option);
  }
}

function buildDaysSelect() {
  const sel = select('days');
  sel.replaceChildren();
  for (const days of index.holding_days) {
    const option = document.createElement('option');
    option.value = String(days);
    option.textContent = `${days} days`;
    sel.append(option);
  }
  sel.value = String(index.holding_days[index.holding_days.length - 1]);
}

/**
 * Snap a requested range to a width this pool can actually hold.
 *
 * Tick spacing is binding: a pool whose spacing is coarser than the half-width cannot
 * express the range at all. Interpolating between the widths that were precomputed would
 * be inventing a number, so the request is snapped and the interface says so.
 * @param {string} poolId
 * @param {number} requestedPct
 */
function snapWidth(poolId, requestedPct) {
  const info = poolInfo.get(poolId);
  const available = index.widths
    .map((/** @type {string} */ name, /** @type {number} */ i) => ({ name, pct: widthPct[i] }))
    .filter((/** @type {{name: string, pct: number|null}} */ w) =>
      info.expressible_widths.includes(w.name) && w.pct !== null);
  if (available.length === 0) return { name: 'full', pct: null, snapped: true };
  let best = available[0];
  for (const w of available) {
    if (Math.abs(/** @type {number} */ (w.pct) - requestedPct)
        < Math.abs(/** @type {number} */ (best.pct) - requestedPct)) best = w;
  }
  return { name: best.name, pct: best.pct, snapped: Math.abs(/** @type {number} */ (best.pct) - requestedPct) > 0.01 };
}

/* ------------------------------------------------------------------ fetch */

/** @param {string} poolId */
async function kernelsFor(poolId) {
  if (!kernelCache.has(poolId)) {
    kernelCache.set(poolId, fetch(`/data/windows/${poolId}.json`).then((r) => r.json()));
  }
  return kernelCache.get(poolId);
}

/* ----------------------------------------------------------------- render */

async function render() {
  const poolId = select('pool').value;
  const requested = Number(input('range').value);
  const days = Number(select('days').value);
  const size = Number(input('size').value);
  const body = el('result-body');

  const width = snapWidth(poolId, requested);
  const snap = el('snap');
  if (width.snapped && width.pct !== null) {
    snap.hidden = false;
    const info = poolInfo.get(poolId);
    snap.textContent =
      `Snapped to ±${width.pct}%, the nearest range this pool can express at its ` +
      `${info.tick_spacing}-tick spacing. Nothing is interpolated between widths.`;
  } else {
    snap.hidden = true;
  }

  if (!(size > 0) || !Number.isFinite(size)) {
    body.replaceChildren(node('p', 'empty', 'Enter an amount to see how this would have gone.'));
    return;
  }

  const kernels = await kernelsFor(poolId);
  /** @type {Map<number, number>} */
  const slotToRow = new Map(kernels.window_index.map((/** @type {number} */ s, /** @type {number} */ i) => [s, i]));

  const widthSlot = index.widths.indexOf(width.name);
  const poolSlot = index.pools.indexOf(poolId);

  /** @type {{net: number, fees: number, il: number, start: number, inRange: number}[]} */
  const outcomes = [];
  let worstKernelError = 0;
  for (let i = 0; i < index.count; i++) {
    if (columns.pool_id[i] !== poolSlot) continue;
    if (columns.width[i] !== widthSlot) continue;
    if (columns.days[i] !== days) continue;
    const row = slotToRow.get(i);
    if (row === undefined) continue;
    const totals = kernels.fee_kernel_totals[row];
    const active = kernels.fee_kernel_active[row];
    const k = kernels.liquidity_per_dollar[row];
    const { feesPct, ilPct, netPct } = netVsHodlPct(
      { il_vs_hodl_pct: columns.il_vs_hodl_pct[i], liquidity_per_dollar: k }, totals, active, size,
    );
    worstKernelError = Math.max(worstKernelError, kernels.kernel_max_rel_error[row] || 0);
    outcomes.push({
      net: netPct, fees: feesPct, il: ilPct,
      start: columns.start_ts[i], inRange: columns.time_in_range_pct[i],
    });
  }

  if (outcomes.length === 0) {
    body.replaceChildren(node('p', 'empty',
      `This pool has not traded long enough for a ${days}-day window. Try a shorter one.`));
    el('result-note').textContent = '';
    return;
  }

  const nets = outcomes.map((o) => o.net);
  const p5 = quantile(nets, 0.05);
  const p50 = quantile(nets, 0.5);
  const p95 = quantile(nets, 0.95);
  const beat = nets.filter((n) => n > 0).length;
  const median = outcomes.slice().sort((a, b) => a.net - b.net)[Math.floor(outcomes.length / 2)];

  body.replaceChildren();

  // The spread is the answer. A middle figure on its own is the point estimate this
  // calculator exists to replace, so the distribution is drawn first and the summary
  // numbers sit underneath it.
  const { counts, min, max } = histogram(nets, 26);
  const tallest = Math.max(...counts);
  const hist = node('div', 'hist');
  hist.setAttribute('role', 'img');
  hist.setAttribute('aria-label',
    `Spread of results across ${outcomes.length} windows. Worst one in twenty ${pct(p5, 2)}, `
    + `middle ${pct(p50, 2)}, best one in twenty ${pct(p95, 2)}. `
    + `${beat} of ${outcomes.length} windows beat holding.`);
  counts.forEach((/** @type {number} */ c, /** @type {number} */ i) => {
    const centre = min + ((i + 0.5) / counts.length) * (max - min);
    const col = node('div', 'hist-col');
    col.style.height = `${tallest ? (c / tallest) * 100 : 0}%`;
    col.title = `${c} window${c === 1 ? '' : 's'} near ${pct(centre, 2)}`;
    hist.append(col);
  });

  // Break-even is drawn rather than coloured, and only when it is actually in range —
  // labelling a marker that is not there would be worse than not marking it.
  const spansZero = min < 0 && max > 0;
  const zero = node('div', 'hist-zero');
  if (spansZero) {
    const line = node('span');
    line.style.left = `${((0 - min) / (max - min)) * 100}%`;
    zero.append(line);
  }
  const axis = node('div', 'hist-axis');
  axis.append(
    node('span', '', pct(min, 1)),
    node('span', '', spansZero ? 'break even at 0%'
      : beat === outcomes.length ? 'every window beat holding' : 'no window beat holding'),
    node('span', '', pct(max, 1)),
  );
  body.append(hist, zero, axis);

  const quantiles = node('div', 'quantiles');
  for (const [key, value] of [
    ['worst 1 in 20', pct(p5, 2)],
    ['middle', pct(p50, 2)],
    ['best 1 in 20', pct(p95, 2)],
    ['beat holding', `${beat} of ${outcomes.length}`],
  ]) {
    const item = node('div');
    item.append(node('span', 'quantile-key', key), node('span', 'quantile-value', value));
    quantiles.append(item);
  }
  body.append(quantiles);

  const head = node('div', 'result-head');
  for (const [key, value] of [
    ['fees earned', pct(median.fees, 2)],
    ['lost to price moves', pct(median.il, 2)],
    ['time in range', pct(median.inRange, 0)],
    ['on', money(size)],
  ]) {
    const stat = node('div', 'stat');
    stat.append(node('span', 'stat-key', key), node('span', 'stat-value', value));
    head.append(stat);
  }
  body.append(head);

  el('result-note').textContent =
    `${outcomes.length} overlapping ${days}-day windows, each a real stretch of trading. `
    + 'Figures are a share of the amount put in. Fees carry up to '
    + `${(worstKernelError * 100).toFixed(2)}% error.`;
}

/* ----------------------------------------------------------------- static */

function renderProvenance() {
  const target = el('provenance');
  const subsidy = subsidyNote(prov.subsidy);
  target.replaceChildren();
  for (const [key, value] of [
    ['measured', stamp(prov.anchors.executable_depth_anchor.ts)],
    ['volume to', stamp(prov.anchors.swap_tape_end.ts)],
    ['windows', String(index.count)],
  ]) {
    const item = node('div', 'prov-item');
    item.append(node('span', 'prov-key', key), node('span', 'prov-value', value));
    target.append(item);
  }
  const caveat = node('div', 'prov-item prov-item--caveat');
  caveat.append(node('span', 'prov-key', subsidy.label), node('span', 'prov-value', subsidy.text));
  target.append(caveat);
}

function renderMethod() {
  const body = el('method-body');
  body.replaceChildren();
  for (const text of [
    'Providing liquidity earns a share of the fees on every trade that passes through '
      + 'your price range. It also leaves you holding more of whichever token fell. This '
      + 'shows the second subtracted from the first, against having simply held both.',
    'What you lose to price moves does not depend on how much you put in, so it is '
      + 'measured once per window. Only the fee share moves with size: a larger position '
      + 'takes a larger cut of the same fees, so each dollar earns a little less.',
    `Fees are attributed trade by trade, splitting each trade where it crosses a price `
      + `step, and counting only the part that passed through your range. Your position is `
      + `added alongside the money that was already there rather than replacing it, so `
      + `these are the returns of joining a pool, not of being it.`,
    index.how_to_use.ranges_snap,
    prov.subsidy.note,
  ].filter(Boolean)) {
    body.append(node('p', undefined, text));
  }
  el('footer-note').textContent =
    `Generated ${prov.generated_at} from ${prov.source.repo}` +
    (prov.source.commit ? ` at ${prov.source.commit.slice(0, 10)}` : '') + '.';
}

/* ------------------------------------------------------------------- boot */

buildPoolSelect();
buildDaysSelect();
renderProvenance();
renderMethod();
await render();

for (const id of ['pool', 'range', 'days', 'size']) {
  el(id).addEventListener('change', () => { void render(); });
  el(id).addEventListener('input', () => { void render(); });
}
