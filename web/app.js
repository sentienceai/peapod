/**
 * The depth page.
 *
 * Renders from web/data/*.json and nothing else. Every sentence that states a finding
 * comes from lib/findings.js, which is pure and tested — see test/findings.test.mjs for
 * why the sub-pixel line in particular is a function rather than markup.
 */

import { bandSegments, belowMedian, headline, subPixelNote, subsidyNote } from './lib/findings.js';
/**
 * A row of depth.json. findings.js declares only the subset it reads; this is the rest of
 * what the table renders.
 * @typedef {import('./lib/findings.js').Pool & {
 *   depth_flat: number,
 *   median_7d_executable: number,
 *   executable_over_flat_pct: number|null,
 *   volume_per_day_usd: number|null,
 * }} DepthRow
 */
/** @typedef {import('./lib/findings.js').Pool} Pool */
import { compact, money, pct, shortAddress, stamp } from './lib/format.js';

/** @param {string} id */
const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** @param {string} tag @param {string} [cls] @param {string} [text] */
function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const [depth, meta] = await Promise.all([
  fetch('/data/depth.json').then((r) => r.json()),
  fetch('/data/meta.json').then((r) => r.json()),
]);

const pools = depth.pools;
const prov = meta.provenance;

/* ------------------------------------------------------------- provenance */

/** @param {HTMLElement} target */
function renderProvenance(target) {
  const anchors = prov.anchors;
  const subsidy = subsidyNote(prov.subsidy);
  const items = [
    ['measured', stamp(anchors.executable_depth_anchor.ts)],
    ['volume to', stamp(anchors.swap_tape_end.ts)],
    ['pools', String(prov.universe.pools_valued)],
    ['basis', 'executable, tick-map walk'],
  ];
  target.replaceChildren();
  for (const [key, value] of items) {
    const item = node('div', 'prov-item');
    item.append(node('span', 'prov-key', key), node('span', 'prov-value', value));
    target.append(item);
  }
  // The caveat a reader arriving months later needs, in the tense that is true today.
  const caveat = node('div', 'prov-item prov-item--caveat');
  caveat.append(
    node('span', 'prov-key', subsidy.label),
    node('span', 'prov-value', subsidy.text),
  );
  target.append(caveat);
}

/* ------------------------------------------------------------------- band */

function renderBand() {
  const band = el('band');
  const width = band.clientWidth || 1200;
  const { segments, remainder } = bandSegments(pools, width);

  band.replaceChildren();
  segments.forEach((/** @type {{pool: Pool, share: number, rank: number, labelled: boolean}} */ seg) => {
    const s = node('div', 'band-seg');
    s.style.width = `${seg.share}%`;
    s.dataset.rank = String(seg.rank);
    if (seg.labelled) {
      const label = node('div', 'band-label');
      label.append(node('span', 'band-share', pct(seg.share, 2)));
      label.append(node('span', '', `${seg.pool.ticker} ${shortAddress(seg.pool.pool_id)}`));
      s.append(label);
    }
    s.title = `${seg.pool.ticker} ${shortAddress(seg.pool.pool_id)} — ${money(seg.pool.depth_executable)}, ${pct(seg.share, 2)} of chain-wide depth`;
    band.append(s);
  });
  if (remainder) {
    const s = node('div', 'band-seg band-seg--rest');
    s.style.width = `${remainder.share}%`;
    s.title = `${remainder.count} pools, ${pct(remainder.share, 2)} between them`;
    band.append(s);
  }

  band.setAttribute(
    'aria-label',
    `Chain-wide executable depth by pool. ${segments.map((/** @type {{pool: Pool, share: number}} */ s) => `${s.pool.ticker} ${pct(s.share, 2)}`).join(', ')}` +
      (remainder ? `, and ${remainder.count} further pools sharing ${pct(remainder.share, 2)}.` : '.'),
  );

  const scale = el('band-scale');
  scale.replaceChildren();
  for (let p = 0; p <= 100; p += 20) {
    const tick = node('span', 'band-tick', `${p}%`);
    tick.style.left = `${p}%`;
    scale.append(tick);
  }

  el('finding').textContent = headline(pools).text;

  const leader = pools[0];
  const note = el('band-note');
  note.replaceChildren();
  const lead = node('b', undefined,
    `${money(leader.depth_executable)} of ${money(depth.totals.executable_usd)} chain-wide. `);
  note.append(lead, document.createTextNode(subPixelNote(pools, width, money)));
}

/* ------------------------------------------------------------------ table */

function renderTable() {
  const body = el('depth-body');
  const max = Math.max(...pools.map((/** @type {DepthRow} */ p) => p.depth_executable));
  const min = 100;                              // floor the log ruler at $100
  const logMax = Math.log10(max);
  const logMin = Math.log10(min);

  body.replaceChildren();
  pools.forEach((/** @type {DepthRow} */ p, /** @type {number} */ i) => {
    const row = node('tr');

    row.append(node('td', 'rank', String(i + 1)));

    const who = node('td');
    who.append(node('span', 'ticker', p.ticker), document.createTextNode(' '));
    who.append(node('span', 'addr', shortAddress(p.pool_id)));
    row.append(who);

    const cell = node('td', 'ruler');
    const frac = Math.max(0, (Math.log10(Math.max(p.depth_executable, min)) - logMin) / (logMax - logMin));
    const bar = node('span', 'ruler-bar');
    bar.style.width = `${Math.max(frac * 100, 0.6)}%`;
    const amount = node('span', 'num num-strong', money(p.depth_executable));
    amount.style.display = 'block';
    cell.append(amount, bar);
    row.append(cell);

    row.append(node('td', 'num sub', p.executable_over_flat_pct === null
      ? '—' : pct(p.executable_over_flat_pct, 0)));
    row.append(node('td', 'num', money(p.median_7d_executable)));

    const med = node('td', 'num');
    if (p.pct_of_median_executable === null) {
      med.textContent = '—';
    } else {
      const below = p.pct_of_median_executable < 100;
      med.className = `num ${below ? 'sign-low' : 'sign-high'}`;
      med.append(node('span', 'sign-mark', below ? '▼' : '▲'));
      med.append(document.createTextNode(pct(p.pct_of_median_executable, 0)));
    }
    row.append(med);

    row.append(node('td', 'num', compact(p.volume_per_day_usd)));
    body.append(row);
  });

  const { below, of } = belowMedian(pools, 10);
  el('depth-note').textContent =
    `${below} of the top ${of} sit below their own 7-day median. Depth bars are log-scaled.`;
  el('depth-caption').textContent =
    `“vs flat” is executable depth as a percentage of lp-terminal's flat-L figure for the same pool. ` +
    `Under 100% the flat figure overstates depth; over 100% it understates it.`;

  // The log axis is drawn rather than left implicit.
  const head = el('ruler-head');
  const axis = node('span', 'ruler-axis');
  axis.style.display = 'block';
  ['$100', '$10k', '$1M'].forEach((/** @type {string} */ label, /** @type {number} */ idx) => {
    const tick = node('span', '', label);
    tick.style.left = `${(idx / 2) * 100}%`;
    if (idx === 2) tick.style.transform = 'translateX(-100%)';
    axis.append(tick);
  });
  head.append(axis);
}

/* ----------------------------------------------------------------- method */

function renderMethod() {
  const wrap = el('restatements');
  wrap.replaceChildren();
  for (const r of prov.restatements) {
    const block = node('div', 'restatement');
    block.append(node('h3', undefined, `lp-terminal published: “${r.original_claim}”`));
    block.append(node('p', undefined, r.restated));
    block.append(node('p', 'was', r.why));
    wrap.append(block);
  }

  const body = el('method-body');
  body.replaceChildren();
  const paragraphs = [
    prov.depth_bases.executable.what[0].toUpperCase() + prov.depth_bases.executable.what.slice(1) + '.',
    prov.depth_bases.executable.verified[0].toUpperCase() + prov.depth_bases.executable.verified.slice(1) + '.',
    `Fees use ${prov.fee_model.name}: ${prov.fee_model.what}. ${prov.fee_model.price_taker}.`,
    prov.subsidy.note,
  ];
  for (const text of paragraphs) body.append(node('p', undefined, text));

  el('footer-note').textContent =
    `Generated ${prov.generated_at} from ${prov.source.repo}` +
    (prov.source.commit ? ` at ${prov.source.commit.slice(0, 10)}` : '') +
    `. Engine checked against ${prov.engine.cases_checked_this_run} v4-core cases on this run.`;
}

/* ------------------------------------------------------------------- boot */

renderProvenance(el('provenance'));
renderBand();
renderTable();
renderMethod();

// The sub-pixel sentence is about the reader's own screen, so it is recomputed when that
// screen changes rather than baked in at load.
/** @type {ReturnType<typeof setTimeout>|undefined} */
let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderBand, 120);
});
