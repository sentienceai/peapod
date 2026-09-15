/**
 * The findings the page states in words, derived from the data rather than written into
 * the markup.
 *
 * Two of these sentences are load-bearing and are pinned by tests in
 * `test/findings.test.mjs`, because they are exactly the kind of copy that gets trimmed
 * later by someone tidying up:
 *
 *   subPixelNote()  is the whole reason the hero is not a generic stacked share bar. The
 *                   concentration is not merely large, it is past the resolution of the
 *                   display: most pools cannot be drawn at all. Delete the sentence and
 *                   the chart becomes decoration.
 *
 *   subsidyNote()   must reach a reader arriving months after the tape was cut. It reads
 *                   the clock, so once 29 September 2026 has passed it says "ended"
 *                   rather than describing a past date in the future tense.
 *
 * Every function here is pure: data in, string or number out, no DOM. That is what makes
 * them testable, and the reason they live apart from the rendering.
 */

/**
 * @typedef {object} Pool
 * @property {string} pool_id
 * @property {string} ticker
 * @property {number} depth_executable
 * @property {number} share_of_chain_executable_pct
 * @property {number|null} pct_of_median_executable
 */

/*
 * The typedef above is deliberately the MINIMUM these functions read, not the whole
 * depth.json row. A pure module should declare the contract it actually needs, so the
 * tests can build a five-field fixture to probe an edge case instead of inventing a
 * plausible-looking full row and implying those other fields matter here.
 */

/**
 * How many pools cannot be drawn at least one pixel wide in a band of this width.
 *
 * Recomputed whenever the band is measured or resized, so the claim is true of the screen
 * the reader is actually looking at rather than of some reference width.
 * @param {Pool[]} pools
 * @param {number} bandWidthPx
 */
export function subPixel(pools, bandWidthPx) {
  const total = pools.length;
  const width = Number.isFinite(bandWidthPx) && bandWidthPx > 0 ? bandWidthPx : 0;
  const invisible = pools.filter(
    (p) => (p.share_of_chain_executable_pct / 100) * width < 1,
  ).length;
  /** @type {Pool|undefined} */
  let smallest;
  for (const p of pools) {
    if (smallest === undefined || p.depth_executable < smallest.depth_executable) smallest = p;
  }
  return { invisible, total, smallest, widthPx: width };
}

/**
 * The sentence that keeps the hero honest. Names the count, the total and the smallest
 * holding, so a reader who doubts the chart can check all three.
 * @param {Pool[]} pools
 * @param {number} bandWidthPx
 * @param {(n: number) => string} money
 * @returns {string}
 */
export function subPixelNote(pools, bandWidthPx, money) {
  const { invisible, total, smallest } = subPixel(pools, bandWidthPx);
  if (!total || smallest === undefined) return '';
  if (invisible === 0) {
    return `All ${total} pools are wide enough to draw at this width. The smallest holds ${money(smallest.depth_executable)}.`;
  }
  const subject = invisible === 1 ? 'pool is' : 'pools are';
  return `${invisible} of ${total} ${subject} narrower than one pixel at this width; the smallest holds ${money(smallest.depth_executable)}.`;
}

/**
 * The gas-subsidy caveat, in the right tense for the day it is being read.
 * @param {{ends: string, label: string, before_text: string, after_text: string}} subsidy
 * @param {Date} [now]
 */
export function subsidyNote(subsidy, now = new Date()) {
  const ends = new Date(`${subsidy.ends}T00:00:00Z`);
  const past = now.getTime() >= ends.getTime();
  return { label: subsidy.label, text: past ? subsidy.after_text : subsidy.before_text, past };
}

/**
 * The hero headline, stated as a fraction the leader's share actually supports.
 *
 * It was hardcoded once. On a page whose argument is that its numbers are checkable, a
 * headline that cannot go stale is worth more than a better-sounding one: re-run the
 * export on a different tape and this follows the data instead of quietly lying.
 * @param {Pool[]} pools
 */
export function headline(pools) {
  const total = pools.length;
  const share = pools[0]?.share_of_chain_executable_pct ?? 0;
  const fraction =
    share >= 72.5 ? 'three quarters'
      : share >= 58 ? 'two thirds'
        : share >= 45 ? 'half'
          : share >= 30 ? 'a third'
            : null;
  const amount = fraction ?? `${share.toFixed(1)}%`;
  const subject = fraction ? 'one holds' : 'the deepest holds';
  return {
    text: `Of the ${total} tokenized-stock pools on Robinhood Chain, ${subject} ${amount} of everything you could actually trade.`,
    share,
    fraction,
    total,
  };
}

/**
 * How many of the top n pools sit below their own 7-day median depth.
 * @param {Pool[]} pools
 * @param {number} [n]
 */
export function belowMedian(pools, n = 10) {
  const top = pools.slice(0, n);
  const below = top.filter(
    (p) => p.pct_of_median_executable !== null && p.pct_of_median_executable < 100,
  );
  return { below: below.length, of: top.length };
}

/**
 * The segments the hero band draws: every pool that can be seen, then one aggregate for
 * the ones that cannot. The remainder is never dropped — it is labelled and kept, because
 * a band that silently omitted 47 pools would overstate the visible ones.
 * @param {Pool[]} pools
 * @param {number} bandWidthPx
 * @param {number} [minLabelPct] share below which a segment carries no inline label
 */
export function bandSegments(pools, bandWidthPx, minLabelPct = 4) {
  const sorted = [...pools].sort(
    (a, b) => b.share_of_chain_executable_pct - a.share_of_chain_executable_pct,
  );
  const visible = sorted.filter(
    (p) => (p.share_of_chain_executable_pct / 100) * bandWidthPx >= 1,
  );
  const rest = sorted.slice(visible.length);
  const restShare = rest.reduce((sum, p) => sum + p.share_of_chain_executable_pct, 0);
  return {
    segments: visible.map((p, i) => ({
      pool: p,
      share: p.share_of_chain_executable_pct,
      rank: i + 1,
      labelled: p.share_of_chain_executable_pct >= minLabelPct,
    })),
    remainder: rest.length ? { count: rest.length, share: restShare } : null,
  };
}
