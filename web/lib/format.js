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

/** @param {number} ts seconds */
export function stamp(ts) {
  const d = new Date(ts * 1000);
  const date = d.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
  const time = d.toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  });
  return `${date} ${time} UTC`;
}

/** @param {string} poolId */
export function shortAddress(poolId) {
  return poolId.slice(0, 10);
}
