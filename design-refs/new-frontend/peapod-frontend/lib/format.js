/**
 * Every figure on the site goes through here.
 *
 * Two rules the frames are drawn on, and both are in this file so they cannot be forgotten
 * in one place and kept in another:
 *
 *   A SIGNED FIGURE CARRIES THREE CHANNELS — the colour, the ▲/▼ glyph, and its own + or −.
 *   signedMoney() builds all three at once; nothing anywhere should colour a figure by hand.
 *
 *   A TRUE MINUS SIGN, not a hyphen. In tabular figures the hyphen is narrower than the
 *   digits it sits beside, so a column of losses comes out ragged.
 */

const usd0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** @param {string} tag @param {string} [cls] @param {string} [text] */
export function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** @param {string} id */
export const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * Dollars, unsigned. Small amounts keep their cents: the smallest position on this board is
 * under a dollar, and rounding it to $0 deletes the row's whole point.
 * @param {number} n
 */
export function money(n) {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  return `$${a < 10000 ? usd2.format(a) : usd0.format(Math.round(a))}`;
}

/** Compact dollars for a column that has no room: $1.2M, $84k, $912.40. @param {number} n */
export function compact(n) {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return `$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `$${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  return money(n);
}

/**
 * A PRICE, which is not the same problem as an amount of money.
 *
 * This chain lists a $442 stock and a $0.00041 memecoin in the same column. money() rounds to
 * cents and renders the memecoin as $0.00 — a price of zero, which is a different claim from
 * a small price. So a price keeps significant figures instead of a fixed scale, and only
 * drops to cents once there are dollars to round.
 * @param {number} n
 */
export function price(n) {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1000) return `$${usd0.format(Math.round(n))}`;
  if (a >= 1) return `$${usd2.format(n)}`;
  if (a >= 0.01) return `$${n.toFixed(4)}`;
  if (a > 0) return `$${n.toPrecision(2)}`;
  return '$0';
}

/** @param {number} n @param {number} [dp] */
export function pct(n, dp = 1) {
  return Number.isFinite(n) ? `${n.toFixed(dp)}%` : '—';
}

/** @param {number} n @param {number} [dp] */
export function signedPctText(n, dp = 2) {
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(dp)}%`;
}

/** @param {number} n */
export function signedMoneyText(n) {
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : '−'}${money(n)}`;
}

/**
 * A signed figure, with all three channels.
 * @param {number} n @param {string} [cls] extra classes on the wrapper
 * @param {(n: number) => string} [fmt] how to write the magnitude
 */
export function signed(n, cls, fmt = money) {
  const up = n >= 0;
  const s = node('strong', `${up ? 'up' : 'down'}${cls ? ` ${cls}` : ''}`);
  s.append(node('span', 'mark', up ? '▲' : '▼'));
  s.append(document.createTextNode(`${up ? '+' : '−'}${fmt(Math.abs(n))}`));
  return s;
}

/** @param {number} n @param {string} [cls] */
export const signedPct = (n, cls) => signed(n, cls, (x) => `${x.toFixed(2)}%`);

/** @param {string} a */
export const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Elapsed time, measured from the END OF THE TAPE rather than from now.
 *
 * The data is a fixed historical window. Against a wall clock every card reads the same
 * number of months and says nothing about which trader acted last.
 * @param {number} ts seconds @param {number} anchor seconds
 */
export function ago(ts, anchor) {
  if (!ts) return '—';
  const s = Math.max(0, anchor - ts);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}M AGO`;
  if (s < 86400) return `${Math.round(s / 3600)}H AGO`;
  return `${Math.round(s / 86400)}D AGO`;
}

/** A holding time, at the precision that time deserves. @param {number} s seconds */
export function duration(s) {
  if (!Number.isFinite(s) || s <= 0) return '—';
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** @param {number} ts seconds @param {{time?: boolean}} [opts] */
export function stamp(ts, opts = {}) {
  const d = new Date(ts * 1000);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return opts.time ? `${day}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : day;
}

/**
 * The asset tile: two letters on the pastel its class earns.
 * @param {string} symbol @param {string} kind stock | etf | crypto | stable | meme
 * @param {string} [extra]
 */
export function assetTile(symbol, kind, extra) {
  const t = node('span', `asset-tile asset-tile--${kind}${extra ? ` ${extra}` : ''}`,
    (symbol || '?').slice(0, 2).toUpperCase());
  t.setAttribute('aria-hidden', 'true');
  return t;
}

/** A token as it reads in a row: tile, then ticker. @param {{symbol: string, kind: string}} a */
export function token(a) {
  const wrap = node('span', 'token');
  wrap.append(assetTile(a.symbol, a.kind), node('span', 'token-ticker', a.symbol));
  return wrap;
}

const SVG = 'http://www.w3.org/2000/svg';
/**
 * A stroked icon built as nodes rather than parsed from a string.
 * @param {number} size @param {[string, Record<string, string | number>][]} parts
 * @param {Record<string, string | number>} [attrs]
 */
export function icon(size, parts, attrs = {}) {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': 2, 'stroke-linecap': 'round', 'aria-hidden': 'true', ...attrs,
  })) svg.setAttribute(k, String(v));
  for (const [tag, a] of parts) {
    const p = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(a)) p.setAttribute(k, String(v));
    svg.append(p);
  }
  return svg;
}

export const ICONS = {
  search: /** @type {[string, Record<string, string>][]} */ ([
    ['circle', { cx: '11', cy: '11', r: '7' }], ['path', { d: 'M20 20l-3.5-3.5' }]]),
  close: /** @type {[string, Record<string, string>][]} */ ([['path', { d: 'M6 6l12 12M18 6L6 18' }]]),
  clock: /** @type {[string, Record<string, string>][]} */ ([
    ['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M12 7v5l3 2' }]]),
  sort: /** @type {[string, Record<string, string>][]} */ ([
    ['path', { d: 'M7 4v16M7 20l-3-3M17 20V4M17 4l3 3' }]]),
  back: /** @type {[string, Record<string, string>][]} */ ([['path', { d: 'M15 5l-7 7 7 7' }]]),
  copy: /** @type {[string, Record<string, string>][]} */ ([
    ['rect', { x: '9', y: '9', width: '11', height: '11', rx: '2' }],
    ['path', { d: 'M5 15V5a2 2 0 0 1 2-2h8' }]]),
};

/**
 * Copy-to-clipboard, with the outcome said rather than implied.
 * @param {string} text @param {string} [label]
 */
export function copyButton(text, label = 'address') {
  const b = node('button', 'copybtn');
  /** @type {HTMLButtonElement} */ (b).type = 'button';
  b.setAttribute('aria-label', `Copy ${label}`);
  b.append(icon(13, ICONS.copy));
  const live = node('span', 'sr-only');
  live.setAttribute('role', 'status');
  b.append(live);
  b.onclick = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      b.classList.add('is-ok');
      live.textContent = 'Copied';
    } catch {
      // Clipboard denied, insecure context, no permission. Say so: a button that silently
      // does nothing is worse than one that admits it.
      b.classList.add('is-fail');
      live.textContent = 'Could not copy';
    }
    setTimeout(() => { b.classList.remove('is-ok', 'is-fail'); live.textContent = ''; }, 1400);
  };
  return b;
}
