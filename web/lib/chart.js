/**
 * Cumulative realized PnL as an area chart with a hover readout, matching the reference.
 *
 * The reference draws a solid line over a flat tinted fill with a zero baseline, positive
 * area above and negative below in their respective tints. This reproduces that. The hover
 * snaps to the nearest sample rather than interpolating, so the tooltip always names a
 * value that actually occurred.
 */

const NS = 'http://www.w3.org/2000/svg';

// Clip-path ids must be unique per chart instance; several can be on the page at once.
let seq = 0;

/** @param {string} tag @param {Record<string, string|number>} attrs */
function el(tag, attrs) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

/**
 * @param {[number, number][]} series [unix seconds, cumulative value]
 * @param {{width?: number, height?: number, onHover?: (p: [number, number]|null, x: number) => void}} opts
 */
export function areaChart(series, opts = {}) {
  const width = opts.width ?? 900;
  const height = opts.height ?? 220;
  const pad = 28;
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart',
    preserveAspectRatio: 'none' });
  if (!series || series.length < 2) return { svg, at: () => null };

  const xs = series.map((p) => p[0]);
  const ys = series.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const lo = Math.min(...ys, 0);
  const hi = Math.max(...ys, 0);
  const span = hi - lo || 1;
  /** @param {number} t */
  const px = (t) => ((t - x0) / (x1 - x0 || 1)) * width;
  /** @param {number} v */
  const py = (v) => pad + (1 - (v - lo) / span) * (height - pad * 2);

  const zero = py(0);

  // Fill and stroke are split AT THE ZERO LINE, not coloured by the final value: a series
  // that ends positive after a drawdown is green above zero and red below, which is what
  // the reference draws and what the data actually says. Clipping to the two half-planes
  // does this without splitting the path into segments.
  const uid = `c${(seq += 1)}`;
  const defs = el('defs', {});
  const above = el('clipPath', { id: `${uid}-a` });
  above.append(el('rect', { x: 0, y: 0, width, height: Math.max(zero, 0) }));
  const below = el('clipPath', { id: `${uid}-b` });
  below.append(el('rect', { x: 0, y: zero, width, height: Math.max(height - zero, 0) }));
  defs.append(above, below);
  svg.append(defs);

  const path = series.map((p, i) => `${i ? 'L' : 'M'}${px(p[0]).toFixed(2)},${py(p[1]).toFixed(2)}`).join('');
  const area = `${path}L${width},${zero}L0,${zero}Z`;

  svg.append(el('path', { d: area, fill: 'var(--up-fill)', 'clip-path': `url(#${uid}-a)` }));
  svg.append(el('path', { d: area, fill: 'var(--down-fill)', 'clip-path': `url(#${uid}-b)` }));
  svg.append(el('line', { x1: 0, x2: width, y1: zero, y2: zero,
    stroke: 'var(--line)', 'stroke-width': 1 }));
  svg.append(el('path', { d: path, fill: 'none', 'stroke-width': 1.5,
    stroke: 'var(--up)', 'clip-path': `url(#${uid}-a)` }));
  svg.append(el('path', { d: path, fill: 'none', 'stroke-width': 1.5,
    stroke: 'var(--down)', 'clip-path': `url(#${uid}-b)` }));

  const cursor = el('line', { x1: 0, x2: 0, y1: 0, y2: height,
    stroke: 'var(--text-muted)', 'stroke-width': 1, opacity: 0 });
  svg.append(cursor);

  /** Nearest actual sample to a fractional x position. Never an interpolated value. */
  const at = (/** @type {number} */ frac) => {
    const t = x0 + (x1 - x0) * Math.max(0, Math.min(1, frac));
    let best = 0;
    for (let i = 1; i < xs.length; i++) {
      if (Math.abs(xs[i] - t) < Math.abs(xs[best] - t)) best = i;
    }
    cursor.setAttribute('x1', String(px(xs[best])));
    cursor.setAttribute('x2', String(px(xs[best])));
    cursor.setAttribute('opacity', '0.6');
    return { point: series[best], x: px(xs[best]) / width };
  };
  const clear = () => cursor.setAttribute('opacity', '0');
  // The scale, handed back so the axis labels can be placed in HTML rather than in this
  // SVG. The svg is drawn with preserveAspectRatio="none" so it can stretch to any width —
  // which stretches text with it. Labels belong outside the stretched box.
  return { svg, at, clear, scale: { lo, hi, x0, x1, pad, height } };
}
