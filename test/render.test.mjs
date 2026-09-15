/**
 * Renders both pages against the shipped data and checks what they built.
 *
 * This is not a visual check — there is no browser here and this stub does not paint. It
 * answers a narrower question that still matters: does the page put the right content in
 * the right places, from the real files, without throwing. The design decisions it guards
 * are the ones a later edit could silently undo — the sub-pixel sentence reaching the
 * page, the subsidy caveat sitting in the provenance strip rather than the footer, the
 * invisible pools surviving as a labelled remainder, and signed figures carrying an arrow
 * so colour is never the only channel.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { readFile } from 'node:fs/promises';

import { headline } from '../web/lib/findings.js';
import { install } from './dom-stub.mjs';

const depthPools = JSON.parse(
  await readFile(new URL('../web/data/depth.json', import.meta.url), 'utf8'),
).pools;

const { get } = await install(new URL('../web/index.html', import.meta.url));
await import('../web/app.js');

test('the provenance strip carries both anchors and the subsidy caveat', () => {
  const strip = get('provenance');
  const text = strip.textContent;
  assert.match(text, /measured/);
  assert.match(text, /volume to/);
  assert.match(text, /UTC/);
  // The caveat a reader arriving months later needs, in the strip rather than the footer.
  const caveat = strip.byClass('prov-item--caveat');
  assert.equal(caveat.length, 1, 'the subsidy caveat is not in the provenance strip');
  assert.match(caveat[0].textContent, /2026-09-29/);
  assert.match(caveat[0].textContent, /gas subsidy/);
});

test('the band draws every pool, with the invisible ones kept as a remainder', () => {
  const band = get('band');
  const segments = band.byClass('band-seg');
  assert.ok(segments.length > 1, 'the band has no segments');

  const rest = band.byClass('band-seg--rest');
  assert.equal(rest.length, 1, 'the sub-pixel pools were dropped instead of aggregated');

  const widths = segments.map((s) => Number.parseFloat(s.style.width));
  const total = widths.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 100) < 1e-6, `band widths sum to ${total}%, not 100%`);

  // The dominant pool is the darkest ink, and it is labelled.
  assert.equal(segments[0].dataset.rank, '1');
  assert.ok(segments[0].byClass('band-label').length === 1, 'the dominant pool has no label');
  assert.match(band.getAttribute('aria-label'), /SPY/);
});

test('the headline claims a fraction the data actually supports', () => {
  // It used to be hardcoded in the markup. On a page whose argument is that the numbers
  // are checkable, the headline has to be checkable too.
  const text = get('finding').textContent;
  assert.equal(text, 'One pool holds three quarters of it.');
  const share = depthPools[0].share_of_chain_executable_pct;
  assert.ok(share >= 72.5 && share < 80,
    `the headline says three quarters but the leader holds ${share.toFixed(1)}%`);
});

test('the hero states the sub-pixel finding, not a generic summary', () => {
  const note = get('band-note').textContent;
  assert.match(note, /narrower than one pixel/,
    'the sub-pixel sentence is missing; the hero is now a generic stacked bar');
  assert.match(note, /\d+ of \d+/);
  assert.match(note, /the smallest holds \$0\.02/);
  assert.match(note, /chain-wide/);
});

test('the table renders every pool with both depth bases', () => {
  const rows = get('depth-body').byTag('tr');
  assert.equal(rows.length, 66);
  const first = rows[0].byTag('td');
  assert.equal(first[0].textContent, '1');
  assert.match(rows[0].textContent, /SPY/);
  // "vs flat" keeps the correction visible in every row rather than in a footnote.
  assert.match(rows[0].textContent, /87%/);
});

test('signed figures carry an arrow, so colour is never the only channel', () => {
  const rows = get('depth-body').byTag('tr');
  let low = 0;
  let high = 0;
  for (const row of rows) {
    for (const cell of row.byTag('td')) {
      const isLow = cell.className.includes('sign-low');
      const isHigh = cell.className.includes('sign-high');
      if (!isLow && !isHigh) continue;
      const mark = cell.byClass('sign-mark');
      assert.equal(mark.length, 1, 'a signed figure has no arrow');
      assert.equal(mark[0].textContent, isLow ? '▼' : '▲');
      if (isLow) low += 1; else high += 1;
    }
  }
  assert.ok(low > 0 && high > 0, `expected both signs, got ${low} low and ${high} high`);
});

test('the log-scaled depth ruler draws its axis instead of hiding the transform', () => {
  const axis = get('ruler-head').byClass('ruler-axis');
  assert.equal(axis.length, 1, 'the log ruler has no drawn axis');
  assert.match(axis[0].textContent, /\$100/);
  assert.match(axis[0].textContent, /\$1M/);
  assert.match(get('depth-note').textContent, /log-scaled/);
});

test('the headline follows the data rather than the markup', () => {
  // Every band of the scale says something a reader can check against the leader's share.
  const cases = [
    [76, 'One pool holds three quarters of it.'],
    [61, 'One pool holds two thirds of it.'],
    [47, 'One pool holds half of it.'],
    [33, 'One pool holds a third of it.'],
    [12, 'The deepest pool holds 12.0% of it.'],
  ];
  for (const [share, expected] of cases) {
    const pools = [{ pool_id: '0x1', ticker: 'X', depth_executable: 1,
      share_of_chain_executable_pct: /** @type {number} */ (share),
      pct_of_median_executable: 100 }];
    assert.equal(headline(pools).text, expected);
  }
});

test('the method section carries both restatements', () => {
  const text = get('restatements').textContent;
  assert.match(text, /nine of the top ten pools are below their 7-day median/);
  assert.match(text, /8 of 10, not nine of ten/);
  assert.match(text, /not an upper bound/);
});

test('the calculator renders a distribution, not a point estimate', async () => {
  const calc = await install(new URL('../web/calculator.html', import.meta.url));
  await import('../web/calc.js');
  const body = calc.get('result-body');

  const hist = body.byClass('hist');
  assert.equal(hist.length, 1, 'no distribution rendered');
  assert.ok(hist[0].byClass('hist-col').length > 5, 'the histogram has almost no bars');
  assert.match(hist[0].getAttribute('aria-label'), /Distribution of net return/);

  const quantiles = body.byClass('quantiles')[0].textContent;
  for (const label of ['5th percentile', 'median', '95th percentile', 'beat holding']) {
    assert.ok(quantiles.includes(label), `the readout is missing ${label}`);
  }
  // The fee estimate's error bound is surfaced rather than implying exactness.
  assert.match(calc.get('result-note').textContent, /relative error/);
});
