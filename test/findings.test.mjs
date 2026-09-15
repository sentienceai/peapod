/**
 * Pins the two load-bearing sentences on the page.
 *
 * The sub-pixel line is the only thing separating this hero from a generic stacked share
 * bar: the finding is not that one pool is large but that most pools cannot be drawn at
 * all. It is one line of copy in a file full of numbers, which makes it the first thing a
 * later tidy-up removes. So it is a tested function, not markup.
 *
 * The subsidy note has the same problem in a different direction: it is correct today and
 * silently wrong in October, when a reader would be told a subsidy "ends" on a date that
 * has passed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  bandSegments,
  belowMedian,
  subPixel,
  subPixelNote,
  subsidyNote,
} from '../web/lib/findings.js';

const depth = JSON.parse(
  await readFile(new URL('../web/data/depth.json', import.meta.url), 'utf8'),
);
const meta = JSON.parse(
  await readFile(new URL('../web/data/meta.json', import.meta.url), 'utf8'),
);
const pools = depth.pools;
/** @param {number} n */
const money = (n) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

test('the shipped data still has a tail that cannot be drawn', () => {
  // If this ever fails the finding has genuinely changed and the hero needs rethinking —
  // which is the point of asserting it rather than trusting the copy.
  const { invisible, total } = subPixel(pools, 1400);
  assert.ok(total > 50, `only ${total} pools in the file`);
  assert.ok(invisible > total / 2,
    `only ${invisible} of ${total} pools are sub-pixel at 1400px; the hero's premise is gone`);
});

test('the sub-pixel line names the count, the total and the smallest holding', () => {
  const note = subPixelNote(pools, 1400, money);
  const { invisible, total, smallest } = subPixel(pools, 1400);
  assert.ok(note.length > 0, 'the sub-pixel line is empty');
  assert.match(note, new RegExp(`\\b${invisible}\\b`), 'the line does not state the count');
  assert.match(note, new RegExp(`\\b${total}\\b`), 'the line does not state the total');
  assert.ok(smallest !== undefined, 'no smallest pool');
  assert.ok(note.includes(money(smallest.depth_executable)),
    'the line does not state the smallest holding');
  assert.match(note, /narrower than one pixel/,
    'the line no longer says what it is about: that these pools cannot be drawn');
});

test('the sub-pixel count tracks the width it is told about', () => {
  // The sentence is about the reader's own screen, so it must move with the screen.
  const narrow = subPixel(pools, 400).invisible;
  const wide = subPixel(pools, 4000).invisible;
  assert.ok(narrow > wide, `${narrow} sub-pixel at 400px vs ${wide} at 4000px`);
  assert.equal(subPixel(pools, 0).widthPx, 0);
});

test('a hypothetical flat distribution says so instead of pretending', () => {
  const flat = Array.from({ length: 10 }, (_, i) => ({
    pool_id: `0x${i}`, ticker: 'X', depth_executable: 1000,
    share_of_chain_executable_pct: 10, pct_of_median_executable: 100,
  }));
  const note = subPixelNote(flat, 1400, money);
  assert.match(note, /All 10 pools are wide enough/);
  assert.doesNotMatch(note, /narrower than one pixel/);
});

test('the band keeps the invisible pools as a labelled remainder', () => {
  // Dropping them would overstate every segment that is drawn.
  const { segments, remainder } = bandSegments(pools, 1400);
  assert.ok(remainder, 'no remainder segment; 47 pools would be silently missing');
  assert.equal(segments.length + remainder.count, pools.length);
  const totalShare = segments.reduce((s, x) => s + x.share, 0) + remainder.share;
  assert.ok(Math.abs(totalShare - 100) < 1e-6, `band sums to ${totalShare}%, not 100%`);
  assert.ok(segments[0].labelled, 'the dominant pool carries no label');
});

test('the subsidy note is in the right tense on both sides of the date', () => {
  const subsidy = meta.provenance.subsidy;
  const before = subsidyNote(subsidy, new Date('2026-09-15T00:00:00Z'));
  assert.equal(before.past, false);
  assert.match(before.text, /\bends\b/);

  const after = subsidyNote(subsidy, new Date('2026-11-20T00:00:00Z'));
  assert.equal(after.past, true);
  assert.match(after.text, /\bended\b/);
  assert.doesNotMatch(after.text, /\bends\b/,
    'a reader in November would be told the subsidy ends on a date that has passed');
});

test('the subsidy note names the date it turns on', () => {
  const subsidy = meta.provenance.subsidy;
  assert.equal(subsidy.ends, '2026-09-29');
  for (const when of ['2026-09-15T00:00:00Z', '2026-11-20T00:00:00Z']) {
    assert.match(subsidyNote(subsidy, new Date(when)).text, /2026-09-29/);
  }
});

test('the restated median count agrees with the shipped pools', () => {
  const { below, of } = belowMedian(pools, 10);
  const restatement = meta.provenance.restatements.find((/** @type {{id: string}} */ r) => r.id === 'top10_below_7d_median');
  assert.equal(below, restatement.peapod_count);
  assert.equal(of, restatement.peapod_of);
  assert.equal(below, 8, 'the restated count no longer matches the data');
});
