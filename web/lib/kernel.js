/**
 * Evaluating a window's fee kernel in the browser.
 *
 * The export ships, per window, a set of buckets: G is the fees in dollars paid by swap
 * segments whose active liquidity sat near A. A position of liquidity L earned a pro-rata
 * share of each, so its fees are sum(G * L / (L + A)) — the same functional form as the
 * exact per-segment sum, which is why this is an evaluation and not an interpolation.
 *
 * The export measured its own bucketing error against the exact sum and narrowed the
 * buckets until it was under a tenth of a percent, shipping the measured bound per window
 * as `kernel_max_rel_error`. The UI surfaces that number rather than implying the answer
 * is exact.
 */

/**
 * Fees in dollars a position of `liquidity` would have earned in this window.
 * @param {number[]} totals bucket fee totals, in dollars
 * @param {number[]} active bucket active-liquidity representatives
 * @param {number} liquidity the position's liquidity
 */
export function evaluateKernel(totals, active, liquidity) {
  if (!(liquidity > 0)) return 0;
  let sum = 0;
  for (let i = 0; i < totals.length; i++) {
    sum += (totals[i] * liquidity) / (liquidity + active[i]);
  }
  return sum;
}

/**
 * What a position of `size` dollars would have done over one window, against holding.
 *
 * The IL term is size-independent — position value and the hold benchmark are both linear
 * in liquidity, and liquidity is linear in notional — so it is taken from the window as a
 * percentage. Only the fee term moves with size, and only through the pro-rata share.
 * @param {{il_vs_hodl_pct: number, liquidity_per_dollar: number}} window
 * @param {number[]} totals
 * @param {number[]} active
 * @param {number} size dollars
 */
export function netVsHodlPct(window, totals, active, size) {
  if (!(size > 0)) return { feesPct: 0, ilPct: window.il_vs_hodl_pct, netPct: window.il_vs_hodl_pct };
  const fees = evaluateKernel(totals, active, window.liquidity_per_dollar * size);
  const feesPct = (fees / size) * 100;
  return { feesPct, ilPct: window.il_vs_hodl_pct, netPct: feesPct + window.il_vs_hodl_pct };
}

/**
 * Quantiles of a sample, linearly interpolated. Used for the distribution readout, which
 * is the answer the calculator exists to give — a median alone would be the point
 * estimate this tool is meant to replace.
 * @param {number[]} values
 * @param {number} q between 0 and 1
 */
export function quantile(values, q) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Bin values into a histogram over a shared range.
 * @param {number[]} values
 * @param {number} bins
 */
export function histogram(values, bins = 26) {
  if (values.length === 0) return { counts: [], min: 0, max: 0 };
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) { min -= 0.5; max += 0.5; }
  const counts = new Array(bins).fill(0);
  for (const v of values) {
    const idx = Math.min(bins - 1, Math.floor(((v - min) / (max - min)) * bins));
    counts[idx] += 1;
  }
  return { counts, min, max };
}
