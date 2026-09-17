/** Number and date formatting. Every figure on the site goes through here. */

const usd0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Dollars. Small amounts keep their cents, because on this page the smallest pool holds
 * two cents and rounding it to $0 would delete the finding.
 * @param {number} n
 */
export function money(n) {
  if (!Number.isFinite(n)) return '—';
  return `$${Math.abs(n) < 1000 ? usd2.format(n) : usd0.format(Math.round(n))}`;
}

/**
 * A signed change, in percentage points. Uses a true minus sign, which aligns with
 * tabular figures where a hyphen does not.
 *
 * This exists because the table used to print a LEVEL where a reader expects a CHANGE:
 * "99% of its 7-day median" rendered as a down-arrow and 99%, which reads as a 99% collapse
 * and means a 1% dip. A level and a delta cannot share a column.
 * @param {number} n a level in percent, where 100 means unchanged
 * @param {number} [dp]
 */
export function delta(n, dp = 0) {
  if (!Number.isFinite(n)) return '—';
  const d = n - 100;
  const sign = d < 0 ? '\u2212' : '+';
  return `${sign}${Math.abs(d).toFixed(dp)}%`;
}

/** @param {number} n @param {number} [dp] */
export function pct(n, dp = 1) {
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(dp)}%`;
}

/** @param {number|null|undefined} n */
export function compact(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return money(n);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** @param {number} ts seconds */
export function stamp(ts) {
  // Built by hand rather than through toLocaleDateString: en-GB renders September as
  // "Sept", which is four characters in a column of three and reads as a typo.
  const d = new Date(ts * 1000);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** @param {string} poolId */
export function shortAddress(poolId) {
  return poolId.slice(0, 10);
}
