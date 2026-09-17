/**
 * Sparklines and the larger area chart, drawn as SVG nodes.
 *
 * ONE COLOUR RULE HERE TOO: the line is the sign of where the series ENDED, and the fill
 * under it is the matching wash. A curve that finished down is drawn in the negative colour
 * whatever it did in the middle — the card's figure says the same thing, and two channels
 * disagreeing is worse than one.
 *
 * The line is drawn in user units and scaled by the viewBox, so one implementation serves a
 * 240×88 card and a 900×300 panel without a second set of numbers.
 */

const SVG = 'http://www.w3.org/2000/svg';

/** @param {string} tag @param {Record<string, string | number>} attrs */
function el(tag, attrs) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

/**
 * @param {[number, number][] | number[][]} series [x, y] pairs
 * @param {{width?: number, height?: number, pad?: number, fill?: boolean, dot?: boolean}} [opts]
 */
export function sparkline(series, opts = {}) {
  const w = opts.width ?? 240;
  const h = opts.height ?? 88;
  const pad = opts.pad ?? 4;
  const svg = el('svg', {
    viewBox: `0 0 ${w} ${h}`, width: '100%', height: '100%',
    preserveAspectRatio: 'none', 'aria-hidden': 'true', class: 'spark',
  });
  const pts = (series ?? []).filter((p) => Array.isArray(p) && Number.isFinite(p[1]));
  if (pts.length < 2) return svg;

  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs); const x1 = Math.max(...xs);
  let y0 = Math.min(...ys); let y1 = Math.max(...ys);
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  // Zero is inside the frame when the series crosses it, so the baseline means something.
  y0 = Math.min(y0, 0); y1 = Math.max(y1, 0);

  const sx = (/** @type {number} */ x) => pad + ((x - x0) / (x1 - x0 || 1)) * (w - pad * 2);
  const sy = (/** @type {number} */ y) => h - pad - ((y - y0) / (y1 - y0 || 1)) * (h - pad * 2);

  const up = ys[ys.length - 1] >= 0;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(2)} ${sy(p[1]).toFixed(2)}`).join('');
  const zero = sy(0);

  if (opts.fill !== false) {
    const area = el('path', {
      d: `${d}L${sx(x1).toFixed(2)} ${zero.toFixed(2)}L${sx(x0).toFixed(2)} ${zero.toFixed(2)}Z`,
      fill: up ? 'var(--up-bg)' : 'var(--down-bg)', stroke: 'none',
    });
    svg.append(area);
  }
  svg.append(el('line', {
    x1: 0, x2: w, y1: zero, y2: zero, stroke: 'var(--line)', 'stroke-width': 1,
  }));
  svg.append(el('path', {
    d, fill: 'none', stroke: up ? 'var(--up)' : 'var(--down)',
    'stroke-width': 1.6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    'vector-effect': 'non-scaling-stroke',
  }));
  if (opts.dot) {
    svg.append(el('circle', {
      cx: sx(pts[pts.length - 1][0]), cy: sy(pts[pts.length - 1][1]), r: 2.4,
      fill: up ? 'var(--up)' : 'var(--down)',
    }));
  }
  return svg;
}

/**
 * The full-size chart: the same curve with a grid, an axis and a hover readout.
 * @param {[number, number][] | number[][]} series
 * @param {{width?: number, height?: number, onHover?: (p: number[] | null) => void}} [opts]
 */
export function areaChart(series, opts = {}) {
  const w = opts.width ?? 900;
  const h = opts.height ?? 300;
  const wrap = document.createElement('div');
  wrap.className = 'chart';
  const svg = el('svg', {
    viewBox: `0 0 ${w} ${h}`, width: '100%', height: '100%',
    preserveAspectRatio: 'none', class: 'chart-svg', role: 'img',
  });
  const pts = (series ?? []).filter((p) => Array.isArray(p) && Number.isFinite(p[1]));
  if (pts.length < 2) { wrap.append(svg); return wrap; }

  const ys = pts.map((p) => p[1]);
  let y0 = Math.min(0, ...ys); let y1 = Math.max(0, ...ys);
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const x0 = pts[0][0]; const x1 = pts[pts.length - 1][0];
  const sx = (/** @type {number} */ x) => ((x - x0) / (x1 - x0 || 1)) * w;
  const sy = (/** @type {number} */ y) => h - 12 - ((y - y0) / (y1 - y0 || 1)) * (h - 24);

  // Four guides, the zero line among them if it is inside the range.
  for (let i = 0; i <= 3; i += 1) {
    const y = y0 + ((y1 - y0) * i) / 3;
    svg.append(el('line', { x1: 0, x2: w, y1: sy(y), y2: sy(y), stroke: 'var(--grid)', 'stroke-width': 1 }));
  }
  const up = ys[ys.length - 1] >= 0;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(2)} ${sy(p[1]).toFixed(2)}`).join('');
  svg.append(el('path', {
    d: `${d}L${w} ${sy(0)}L0 ${sy(0)}Z`, fill: up ? 'var(--up-bg)' : 'var(--down-bg)', stroke: 'none',
  }));
  svg.append(el('line', { x1: 0, x2: w, y1: sy(0), y2: sy(0), stroke: 'var(--line-strong)', 'stroke-width': 1 }));
  svg.append(el('path', {
    d, fill: 'none', stroke: up ? 'var(--up)' : 'var(--down)', 'stroke-width': 2,
    'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke',
  }));

  const cursor = el('line', { x1: 0, x2: 0, y1: 0, y2: h, stroke: 'var(--line-strong)', 'stroke-width': 1, opacity: 0 });
  svg.append(cursor);
  wrap.append(svg);

  if (opts.onHover) {
    svg.addEventListener('mousemove', (e) => {
      const box = svg.getBoundingClientRect();
      const rel = ((e.clientX - box.left) / box.width) * (x1 - x0) + x0;
      let best = pts[0];
      for (const p of pts) if (Math.abs(p[0] - rel) < Math.abs(best[0] - rel)) best = p;
      cursor.setAttribute('x1', String(sx(best[0])));
      cursor.setAttribute('x2', String(sx(best[0])));
      cursor.setAttribute('opacity', '1');
      opts.onHover?.(best);
    });
    svg.addEventListener('mouseleave', () => {
      cursor.setAttribute('opacity', '0');
      opts.onHover?.(null);
    });
  }
  return wrap;
}
