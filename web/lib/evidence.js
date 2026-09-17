/**
 * Is this record distinguishable from luck?
 *
 * Hyperdash puts a 0-100 "Copy Score" here. We do not have one and will not invent one:
 * a composite of undisclosed weights is exactly the kind of label this project refuses to
 * ship, because nobody can check it and it reads as authority. What goes in that slot
 * instead is one measurable question with a published answer.
 *
 * THE QUESTION. An address closed n round-trips and k of them at a profit. If it had no
 * skill at all — a coin-flip on every close — where would its win count land? That null is
 * a binomial with p = 0.5, and the band drawn is its exact two-sided 95% acceptance
 * region: the set of win counts a coin-flipper is NOT rejected at, at one time in twenty.
 * An observed count outside it is one chance produces less than 5% of the time.
 *
 * WHY EXACT AND NOT THE NORMAL APPROXIMATION, which is what this used to do.
 *
 * The band was 0.5 +/- 1.96*sqrt(0.25/n) — the score test for a proportion, inverting to
 * the Wilson interval. It is the right test asymptotically and it overclaims at the small
 * end, where most of this table lives. At n = 4 it drew a band of 1% to 99% and reported
 * a 4/4 record as beyond chance. The exact probability of four heads in four flips is
 * 2 * (1/2)^4 = 0.125 — one time in eight, not one in twenty. The published criterion said
 * 95% of coin-flippers land inside the band, and of that band they do not: 2/16 of them
 * land outside it.
 *
 * NO OUTCOME CAN BE SIGNIFICANT UNTIL n = 6. The most extreme result available is all
 * wins or none, at 2 * (1/2)^n, and that first reaches 0.05 at
 *
 *     n = 5   2 * (1/2)^5 = 0.0625   still cannot reject
 *     n = 6   2 * (1/2)^6 = 0.0312   can reject
 *
 * so at n <= 5 the test has no power at all and the honest answer is that there is not
 * enough here to tell. That is the same rule as before — the region covers every possible
 * outcome, so it is an absence of a finding rather than a finding of "within" — applied to
 * the exact region instead of the approximate one. It moves the threshold from 3 to 5.
 *
 * DOUBLING THE SMALLER TAIL IS THE CORRECT TWO-SIDED TEST HERE, and only because the null
 * is p = 0.5: the binomial is then symmetric, so doubling and the minimum-likelihood method
 * pick out the same set. Under any other null they differ and this would need rewriting.
 *
 * THE TWO METHODS DISAGREE AT EVERY SCALE, not just the small end — checked over every
 * (n, k) with n up to 1000, where they part company on 987 pairs and still disagree at
 * n = 1000. The normal band has no continuity correction and sits slightly inside the
 * exact one, so there is no n above which it is safe to switch. It is exact throughout.
 * The cost is O(n) per address, computed once per distinct n and cached.
 *
 * WHAT IT DOES NOT SAY. It says nothing about whether the address made money. A trader
 * can win nine closes out of ten and lose on the tenth by more than the nine made, and
 * this will still read "beyond chance" — correctly, because the question asked is about
 * the win rate and not the sum. The realized figure is on the same card, larger.
 */

/**
 * The exact two-sided 95% acceptance region for Binomial(n, 0.5), as win counts.
 *
 * Weights are held RELATIVE TO THE MODE rather than as probabilities. C(n, k) / 2^n
 * underflows a double at n > 1074 and this table has addresses with thousands of closes;
 * dividing through by the largest term keeps every value in [0, 1] at any n, and the tail
 * comparisons are ratios, so the normalisation cancels.
 * @param {number} n @param {number} alpha
 */
function acceptanceRegion(n, alpha = 0.05) {
  const hit = REGIONS.get(n);
  if (hit) return hit;
  const mode = Math.floor(n / 2);
  const w = new Float64Array(n + 1);
  w[mode] = 1;
  for (let k = mode; k < n; k += 1) w[k + 1] = (w[k] * (n - k)) / (k + 1);
  for (let k = mode; k > 0; k -= 1) w[k - 1] = (w[k] * k) / (n - k + 1);
  let total = 0;
  for (let k = 0; k <= n; k += 1) total += w[k];

  let lower = 0;
  let klo = 0;
  for (let k = 0; k <= n; k += 1) {
    lower += w[k];
    if (Math.min(1, (2 * lower) / total) > alpha) { klo = k; break; }
  }
  let upper = 0;
  let khi = n;
  for (let k = n; k >= 0; k -= 1) {
    upper += w[k];
    if (Math.min(1, (2 * upper) / total) > alpha) { khi = k; break; }
  }
  const region = { klo, khi, powerless: klo === 0 && khi === n };
  REGIONS.set(n, region);
  return region;
}

/** @type {Map<number, {klo: number, khi: number, powerless: boolean}>} */
const REGIONS = new Map();

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
  const k = Math.min(n, Math.max(0, Math.round(wins)));
  const rate = k / n;
  const { klo, khi, powerless } = acceptanceRegion(n);
  // The band as rates, for drawing. The comparison below is on COUNTS, not on these — the
  // null is discrete and k/n against klo/n invites a float comparison deciding a verdict
  // at the boundary.
  const lo = klo / n;
  const hi = khi / n;
  // Every outcome inside the region: the test cannot reject anything at this n, so there
  // is no finding to report either way. That is not "within chance" — it does not belong
  // beside records that are genuinely indistinguishable from a coin — and at p = 0.5 it is
  // exactly n <= 5.
  if (powerless) {
    return { rate, lo, hi, verdict: 'none', decisive: false,
      label: `Too few closes to tell (${n})` };
  }
  if (k > khi) return { rate, lo, hi, verdict: 'above', decisive: true, label: 'Beyond chance' };
  if (k < klo) return { rate, lo, hi, verdict: 'below', decisive: true, label: 'Below chance' };
  return { rate, lo, hi, verdict: 'within', decisive: false, label: 'Within chance' };
}

/** The published criterion, rendered wherever the bar is explained. */
export const CRITERION = 'Win count on matched round-trips against a coin-flip null: the '
  + 'shaded band is the exact binomial range a trader with no skill and the same number of '
  + 'closes lands in at least 95% of the time. Outside it is beyond what chance produces '
  + 'one time in twenty. Below six closes no result can clear that bar — four wins from '
  + 'four is one chance in eight — so those read "too few closes to tell" rather than a '
  + 'verdict. It measures the rate, not the profit, and only the selling that has an '
  + 'on-chain buy behind it — the coverage figure on each card says how much of that '
  + 'address\'s selling that is. Checked for selection: an address\'s matched sells execute '
  + '0.085% worse than its own unmatched sells against the day\'s average price, not better, '
  + 'so the scored subset is not the flattering half.';

/**
 * How much of an address's selling the test can see.
 *
 * A badge over 12% of someone's flow and a badge over 95% of it are not the same claim,
 * and nothing else on the card distinguishes them.
 * @param {number} outOfScope @param {number} total
 * @returns {number} percent of flow with an on-chain buy behind it
 */
export function coverage(outOfScope, total) {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, (1 - outOfScope / total) * 100));
}
