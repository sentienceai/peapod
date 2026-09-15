/**
 * Sparkline as inline SVG: a line over a flat tinted fill, matching the reference charts.
 *
 * The reference uses a solid stroke over a flat dark tint, not a gradient ramp — sampled
 * at #1f342b under a #76be9d line. This reproduces that rather than reaching for a
 * gradient because gradients read as decoration here.
 *
 * SPLIT AT ZERO, NOT BY THE LAST VALUE. This used to colour the whole series by where it
 * ended, so a run that spent half the window underwater and closed green drew entirely
 * green. That is a claim about the history the history does not support, and the reference
 * cards plainly show red stretches inside otherwise green lines. Fill and stroke are both
 * clipped to the half-planes above and below zero, so the colour at any point is the sign
 * at that point.
 */

const NS = 'http://www.w3.org/2000/svg';

// Clip ids must be unique per instance: a grid of cards puts dozens on one page.
let seq = 0;

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

  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join('');
  const base = y(0);
  const area = `${line}L${width},${base}L0,${base}Z`;
  const uid = `s${(seq += 1)}`;

  const defs = el('defs', {});
  const above = el('clipPath', { id: `${uid}-a` });
  above.append(el('rect', { x: 0, y: 0, width, height: Math.max(base, 0) }));
  const below = el('clipPath', { id: `${uid}-b` });
  below.append(el('rect', { x: 0, y: base, width, height: Math.max(height - base, 0) }));
  defs.append(above, below);
  svg.append(defs);

  svg.append(el('path', { d: area, fill: 'var(--up-fill)', 'clip-path': `url(#${uid}-a)` }));
  svg.append(el('path', { d: area, fill: 'var(--down-fill)', 'clip-path': `url(#${uid}-b)` }));
  svg.append(el('path', { d: line, fill: 'none', 'stroke-width': 1.5,
    stroke: 'var(--up)', 'clip-path': `url(#${uid}-a)` }));
  svg.append(el('path', { d: line, fill: 'none', 'stroke-width': 1.5,
    stroke: 'var(--down)', 'clip-path': `url(#${uid}-b)` }));
  return svg;
}
