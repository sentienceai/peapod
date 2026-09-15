/**
 * Sparkline as inline SVG: a line over a flat tinted fill, matching the reference charts.
 *
 * The reference uses a solid stroke over a flat dark tint with a hatch, not a gradient
 * ramp — sampled at #1f342b under a #76be9d line. This reproduces that rather than
 * reaching for a gradient because gradients read as decoration here.
 */

const NS = 'http://www.w3.org/2000/svg';

/** @param {string} tag @param {Record<string,string|number>} attrs */
function el(tag, attrs) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/**
 * @param {number[]} values cumulative series, may be negative
 * @param {{width?: number, height?: number}} [opts]
 */
export function sparkline(values, opts = {}) {
  const width = opts.width ?? 240;
  const height = opts.height ?? 64;
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, class: 'spark',
    preserveAspectRatio: 'none', role: 'presentation' });
  if (!values || values.length < 2) return svg;

  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const range = max - min || 1;
  /** @param {number} i */
  const x = (i) => (i / (values.length - 1)) * width;
  /** @param {number} v */
  const y = (v) => height - ((v - min) / range) * height;
  const up = values[values.length - 1] >= 0;

  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join('');
  const base = y(0);
  svg.append(el('path', { d: `${line}L${width},${base}L0,${base}Z`,
    fill: up ? 'var(--up-fill)' : 'var(--down-fill)' }));
  svg.append(el('path', { d: line, fill: 'none', 'stroke-width': 1.5,
    stroke: up ? 'var(--up)' : 'var(--down)' }));
  return svg;
}
