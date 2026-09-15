/**
 * Is this record distinguishable from luck?
 *
 * Hyperdash puts a 0-100 "Copy Score" here. We do not have one and will not invent one:
 * a composite of undisclosed weights is exactly the kind of label this project refuses to
 * ship, because nobody can check it and it reads as authority. What goes in that slot
 * instead is one measurable question with a published answer.
 *
 * THE QUESTION. An address closed n round-trips and k of them at a profit. If it had no
 * skill at all — a coin-flip on every close — where would its win rate land? That null is
 * a binomial with p = 0.5, and 95% of coin-flippers with n closes land inside
 *
 *     0.5 +/- 1.96 * sqrt(0.25 / n)
 *
 * so an observed rate outside that band is one a coin-flipper produces less than 5% of
 * the time. This is the score test for a proportion; inverting it gives the Wilson
 * interval, so "outside the band" and "the Wilson interval for this rate excludes 50%"
 * are the same statement. The band is drawn rather than the interval because the band is
 * the thing being compared against.
 *
 * WHAT IT DOES NOT SAY. It says nothing about whether the address made money. A trader
 * can win nine closes out of ten and lose on the tenth by more than the nine made, and
 * this will still read "beyond chance" — correctly, because the question asked is about
 * the win rate and not the sum. The realized figure is on the same card, larger.
 *
 * SMALL n ANSWERS ITSELF. At n = 1 the band is the whole range, so a single lucky trade
 * can never read as skill. No arbitrary minimum is imposed; the arithmetic imposes it.
 */

const Z = 1.96;

/**
 * @param {number} wins @param {number} trips
 * @returns {{rate: number, lo: number, hi: number, verdict: 'above'|'below'|'within'|'none',
 *   label: string, decisive: boolean}}
 */
export function chanceBand(wins, trips) {
  const n = Math.max(0, Math.floor(trips));
  if (!n) {
    return { rate: 0, lo: 0, hi: 1, verdict: 'none', decisive: false,
      label: 'No closed round-trips' };
  }
  const rate = Math.min(1, Math.max(0, wins / n));
  const half = Z * Math.sqrt(0.25 / n);
  const lo = Math.max(0, 0.5 - half);
  const hi = Math.min(1, 0.5 + half);
  // The band covering the whole range is not a finding, it is an absence of one, and it
  // should not be dressed up as "within chance" alongside records that actually sit there.
  if (lo <= 0 && hi >= 1) {
    return { rate, lo, hi, verdict: 'none', decisive: false,
      label: `Too few closes to tell (${n})` };
  }
  if (rate > hi) return { rate, lo, hi, verdict: 'above', decisive: true, label: 'Beyond chance' };
  if (rate < lo) return { rate, lo, hi, verdict: 'below', decisive: true, label: 'Below chance' };
  return { rate, lo, hi, verdict: 'within', decisive: false, label: 'Within chance' };
}

/** The published criterion, rendered wherever the bar is explained. */
export const CRITERION = 'Win rate on matched round-trips against a coin-flip null: '
  + '95% of traders with no skill and the same number of closes land inside the shaded '
  + 'band. Outside it is beyond what chance produces one time in twenty. It measures the '
  + 'rate, not the profit.';
