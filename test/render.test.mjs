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

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { headline } from '../web/lib/findings.js';
import { install } from './dom-stub.mjs';

const depthPools = JSON.parse(
  await readFile(new URL('../web/data/depth.json', import.meta.url), 'utf8'),
).pools;

const { get } = await install(new URL('../archive/web/depth.html', import.meta.url));
await import('../archive/web/depth.js');

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

  // Width is the magnitude. The dominant pool is the only segment in full ink.
  assert.equal(segments[0].dataset.rank, '1');
  assert.match(band.getAttribute('aria-label'), /SPY/);
});

test('the accent points at the pool the page is about, and is used twice', () => {
  // One referent. If it spreads to links or buttons it stops meaning anything.
  const mark = get('band-pointer').byClass('band-pointer-mark');
  assert.equal(mark.length, 1, 'the hero has no pointer at its subject');
  assert.match(mark[0].textContent, /SPY/);
  assert.match(mark[0].textContent, /75\.83%/);
  assert.match(mark[0].textContent, /▲/);

  const rows = get('depth-body').byTag('tr');
  assert.ok(rows[0].className.includes('subject'), 'the subject row is not marked');
  assert.equal(rows[0].byClass('subject-mark').length, 1);
  const otherMarks = rows.slice(1).flatMap((r) => r.byClass('subject-mark'));
  assert.equal(otherMarks.length, 0, 'the accent marks more than one pool');
});

test('the headline claims a fraction the data actually supports', () => {
  const text = get('finding').textContent;
  assert.equal(
    text,
    'Of the 66 tokenized-stock pools on Robinhood Chain, one holds three quarters of everything you could actually trade.',
  );
  const share = depthPools[0].share_of_chain_executable_pct;
  assert.ok(share >= 72.5 && share < 80,
    `the headline says three quarters but the leader holds ${share.toFixed(1)}%`);
  assert.equal(depthPools.length, 66, 'the headline states a pool count the data must match');
});

test('the headline is not written into the markup', () => {
  // This is the reversion the test exists to catch: someone types the sentence into
  // index.html, deletes the derived assignment, and the page goes on claiming three
  // quarters long after the tape says otherwise.
  const markup = readFileSync(new URL('../archive/web/depth.html', import.meta.url), 'utf8');
  for (const fragment of ['three quarters', 'two thirds', 'tokenized-stock pools']) {
    assert.ok(!markup.includes(fragment),
      `index.html hardcodes "${fragment}"; the headline must come from the data`);
  }
  assert.match(markup, /id="finding"><\/h2>/,
    'the headline element should ship empty and be filled from the data');
});

test('the hero states the sub-pixel finding, not a generic summary', () => {
  const note = get('band-note').textContent;
  assert.match(note, /narrower than one pixel/,
    'the sub-pixel sentence is missing; the hero is now a generic stacked bar');
  assert.match(note, /\d+ of \d+/);
  assert.match(note, /the smallest holds \$0\.02/);
  assert.match(note, /across all 66 pools/);
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

test('signed figures carry an explicit sign, so colour is never the only channel', () => {
  // This column used to print a LEVEL with a direction arrow: "▼99%" meant one percent
  // below the 7-day median and read as a 99% collapse. It is now a signed delta, so the
  // sign is in the number itself and needs neither colour nor a glyph to be legible.
  const rows = get('depth-body').byTag('tr');
  let low = 0;
  let high = 0;
  for (const row of rows) {
    for (const cell of row.byTag('td')) {
      const isLow = cell.className.includes('sign-low');
      const isHigh = cell.className.includes('sign-high');
      if (!isLow && !isHigh) continue;
      const text = cell.textContent;
      assert.match(text, /^[\u2212+]\d/,
        `a signed figure reads as a level, not a change: ${text}`);
      assert.equal(text.startsWith('\u2212'), isLow,
        `sign character disagrees with the class: ${text}`);
      if (isLow) low += 1; else high += 1;
    }
  }
  assert.ok(low > 0 && high > 0, `expected both signs, got ${low} low and ${high} high`);
});

test('a one percent dip does not render as a collapse', () => {
  // The specific misreading this replaced: AMD at 99% of its median.
  const rows = get('depth-body').byTag('tr');
  const amd = rows.find((r) => r.textContent.includes('AMD'));
  assert.ok(amd, 'AMD is not in the table');
  const signed = amd.byTag('td').filter((c) => /sign-(low|high)/.test(c.className));
  assert.equal(signed.length, 1);
  const value = Number(signed[0].textContent.replace('\u2212', '-').replace('%', ''));
  assert.ok(Math.abs(value) < 50,
    `AMD renders as ${signed[0].textContent}, which reads far larger than its true change`);
});

test('the table applies no undisclosed transform to magnitudes', () => {
  // A log-scaled bar used to sit in this table. It compressed a 94x gap between the first
  // and tenth pool into bars of 100% and 59% width, which is a transform that flatters the
  // data whether or not its axis is drawn. It was removed rather than relabelled: the hero
  // band already carries magnitude, and the table's job is exact values.
  const body = get('depth-body');
  const scaled = body.descendants().filter((n) => n.style.width !== undefined && n.style.width);
  assert.equal(scaled.length, 0,
    `${scaled.length} scaled elements in the table; a bar here needs a drawn axis or removal`);

  // Magnitude is instead legible as a share, which states the gap rather than drawing it.
  const first = get('depth-body').byTag('tr')[0].byTag('td');
  const shares = first.filter((c) => /%$/.test(c.textContent));
  assert.ok(shares.length >= 1, 'no share column to carry magnitude');
  assert.match(get('depth-note').textContent, /Share is of all depth/);
});

test('the headline follows the data rather than the markup', () => {
  // Every band of the scale says something a reader can check against the leader's share.
  const cases = [
    [76, 'one holds three quarters of'],
    [61, 'one holds two thirds of'],
    [47, 'one holds half of'],
    [33, 'one holds a third of'],
    [12, 'the deepest holds 12.0% of'],
  ];
  for (const [share, expected] of cases) {
    const pools = Array.from({ length: 40 }, (_, i) => ({
      pool_id: `0x${i}`, ticker: 'X', depth_executable: 1,
      share_of_chain_executable_pct: /** @type {number} */ (i === 0 ? share : 0),
      pct_of_median_executable: 100,
    }));
    const { text } = headline(pools);
    assert.ok(text.includes(String(expected)), `share ${share} produced: ${text}`);
    assert.ok(text.startsWith('Of the 40 tokenized-stock pools'), text);
  }
});

test('the method section carries both restatements', () => {
  const text = get('restatements').textContent;
  assert.match(text, /nine of the top ten pools are below their 7-day median/);
  assert.match(text, /8 of 10, not nine of ten/);
  assert.match(text, /not an upper bound/);
});

test('the calculator renders a distribution, not a point estimate', async () => {
  const calc = await install(new URL('../archive/web/calculator.html', import.meta.url));
  await import('../archive/web/calc.js');
  const body = calc.get('result-body');

  const hist = body.byClass('hist');
  assert.equal(hist.length, 1, 'no distribution rendered');
  assert.ok(hist[0].byClass('hist-col').length > 5, 'the histogram has almost no bars');
  // The alternative text must describe a spread too, not read out one number.
  const described = hist[0].getAttribute('aria-label');
  assert.match(described, /Spread of results/);
  assert.match(described, /worst one in twenty/i);
  assert.match(described, /best one in twenty/i);

  // The spread is the answer. A middle figure on its own is the point estimate this
  // calculator exists to replace, so the readout must carry both tails and the count.
  const quantiles = body.byClass('quantiles')[0].textContent;
  for (const label of ['worst 1 in 20', 'middle', 'best 1 in 20', 'beat holding']) {
    assert.ok(quantiles.includes(label), `the readout is missing ${label}`);
  }
  // Break-even is stated on the axis rather than carried by colour. Where zero falls
  // inside the range it is drawn as a line; where it does not, the axis says so rather
  // than labelling a marker that is not there.
  const axis = body.byClass('hist-axis')[0];
  assert.equal(axis.elements().length, 3, 'the axis lost a label');
  assert.match(axis.elements()[1].textContent, /break even|beat holding/,
    'the reader is no longer told where holding sits on this axis');
  // The fee estimate's error bound is surfaced rather than implying exactness.
  assert.match(calc.get('result-note').textContent, /error/);
});
