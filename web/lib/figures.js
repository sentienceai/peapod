/**
 * Two figures this data can support, named for what they actually measure.
 *
 * The mockup asks for Max drawdown and ROI. Both are account-level: they need the value of
 * everything the address holds, over time, which needs the transfer index. These are not
 * those, and are not labelled as those.
 *
 *   realizedDrawdown  the deepest fall of the REALIZED CURVE — the running total of closed
 *                     round-trips — in dollars. It says how far a record gave back what it
 *                     had made. It is not equity: an address holding a position that halved
 *                     shows nothing here, because nothing was closed.
 *
 *   returnOnMatchedCost  realized divided by the cost of the buys that were matched. It is
 *                     the return on the money that went through completed round-trips, not
 *                     on the account: capital sitting in an open position, or never
 *                     deployed, is not in the denominator because it is not visible here.
 *
 * THE DENOMINATOR IS EXACT, not a share of volume. The build's `matched_volume` is both
 * legs of the matched quantity — cost + proceeds — and realized is proceeds − cost, so
 * cost = (matched_volume − realized) / 2 with no approximation and no capped list.
 */

/**
 * The deepest fall of the realized curve, in dollars.
 *
 * PREFERS THE BUILD'S FIGURE. The shipped series is downsampled to 500 points, and a
 * sample can step straight over the trough, so a drawdown computed from it is a LOWER
 * BOUND for an address with more closes than that. export/build_leaderboard.py computes it
 * over every close and ships it as summary.realized_drawdown; this falls back to the curve
 * only when that is absent, and says so with `exact: false` so the page can label it.
 *
 * @param {number[][]} series cumulative realized: [timestamp, cumulative] per close
 * @param {any} [summary] the address summary, if it carries the build's own figure
 * @returns {{ depth: number, peak: number, trough: number, fromTs: number | null,
 *   toTs: number | null, closes: number, exact: boolean, points: number }}
 */
export function realizedDrawdown(series, summary) {
  const shipped = summary?.realized_drawdown;
  if (shipped && Number.isFinite(shipped.depth)) {
    return { depth: shipped.depth, peak: shipped.peak, trough: shipped.trough,
      fromTs: shipped.from_ts ?? null, toTs: shipped.to_ts ?? null,
      closes: shipped.closes, exact: true, points: shipped.closes };
  }
  const points = Array.isArray(series) ? series : [];
  // Complete only when the curve holds a point per close. Where the build's figure is
  // missing and the series was thinned, what comes back is a floor.
  const closes = Number(summary?.round_trips);
  const exact = !Number.isFinite(closes) || points.length >= closes;
  let peak = 0;
  let peakTs = points.length ? points[0][0] : null;
  let depth = 0;
  let best = { depth: 0, peak: 0, trough: 0, fromTs: /** @type {number | null} */ (null),
    toTs: /** @type {number | null} */ (null), closes: Number.isFinite(closes) ? closes : points.length,
    exact, points: points.length };
  // The curve starts at zero: an address that only ever lost is in drawdown from its first
  // close, and reporting nothing there would flatter it.
  for (const [ts, value] of points) {
    if (value > peak) { peak = value; peakTs = ts; }
    const fall = peak - value;
    if (fall > depth) {
      depth = fall;
      best = { depth, peak, trough: value, fromTs: peakTs, toTs: ts, closes: best.closes,
        exact, points: points.length };
    }
  }
  return best;
}

/**
 * @param {{ realized: number, matched_volume: number }} summary
 * @returns {{ cost: number, proceeds: number, pct: number } | null} null when there is no
 *   matched cost to divide by — which is a missing figure, not a zero.
 */
export function returnOnMatchedCost(summary) {
  const realized = Number(summary?.realized);
  const matched = Number(summary?.matched_volume);
  if (!Number.isFinite(realized) || !Number.isFinite(matched)) return null;
  const cost = (matched - realized) / 2;
  if (!(cost > 0)) return null;
  return { cost, proceeds: (matched + realized) / 2, pct: (realized / cost) * 100 };
}

/** What each figure is, in the words that go beside it. */
export const FIGURE_NOTES = {
  realizedDrawdown: 'The deepest fall in this address’s running total of closed '
    + 'round-trips, in dollars. Not account drawdown: an open position that lost value is '
    + 'not in it, because nothing was closed.',
  realizedDrawdownSampled: 'This one is measured on the sampled curve the chart draws, so '
    + 'it is a floor: a deeper fall between two sampled closes would not appear. The build '
    + 'computes it over every close, and that figure replaces this one from the next cycle.',
  returnOnMatchedCost: 'Realized PnL over the cost of the buys that were matched. Not '
    + 'account ROI: money in open positions, or never deployed, is not in the denominator.',
};
