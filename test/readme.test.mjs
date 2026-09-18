/**
 * The README's figures must be the figures the store holds.
 *
 * A front door that quotes numbers from a build three weeks ago is worse than one that
 * quotes none: it reads as authoritative and is wrong. Every figure below is read back
 * out of the shipped store and compared, so a rebuild that moves a number fails here
 * rather than leaving the README quietly stale.
 *
 * Figures that cannot come from the store — the provider cross-check, the tape
 * verification, the CoinGecko agreement — are pinned as strings instead, so that changing
 * one is a deliberate edit with a visible diff rather than a drift.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { view } from './store.mjs';

const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
const all = view('all', '7d');
const rwa = view('rwa', '7d');
const pons = view('pons', '7d');

/** @param {number} n */
const commas = (n) => Math.round(n).toLocaleString('en-US');

test('the headline figures match the shipped build', () => {
  const c = all.coverage;
  const d = all.distribution;
  const want = [
    commas(c.addresses_seen),                                   // 103,920 traded
    commas(c.addresses_qualifying),                             // 30,013 closed a round-trip
    `$${commas(d.percentiles['100'])}`,                         // the best result
    `$${d.percentiles['50'].toFixed(2)}`,                       // the median
    `${(100 - c.matched_flow_pct).toFixed(1)}%`,                // out of scope
    `${d.in_profit_pct.toFixed(1)}%`,                           // in profit
  ];
  for (const figure of want) {
    assert.ok(readme.includes(figure), `README does not state ${figure}`);
  }
  assert.ok(readme.includes(c.universe.split(' and ')[0]), 'README does not state the universe');
});

test('the RWA comparison the README makes is still true of the data', () => {
  // "RWA looks safer than Pons and is not" is an argument, not a quote, so the shape of
  // it is asserted as well as the numbers.
  assert.ok(rwa.distribution.in_profit_pct > pons.distribution.in_profit_pct,
    'RWA is no longer in profit more often than Pons; the README says it is');
  /*
   * The README's claim is an ORDER OF MAGNITUDE, not a particular ratio: "far more RWA
   * addresses finish in profit, and the best of them makes a fraction of what the best
   * memecoin trader makes". This was pinned at 50x, which was the gap on the build it was
   * written against; a later build came in at 36x and failed here, with the sentence still
   * true. So the pin holds the argument — ten times — and the two figures beside it are
   * checked exactly, which is what actually goes stale.
   */
  assert.ok(rwa.distribution.percentiles['100'] < pons.distribution.percentiles['100'] / 10,
    'the magnitude gap the README rests on has closed');
  assert.ok(readme.includes(`${rwa.distribution.in_profit_pct.toFixed(1)}%`));
  assert.ok(readme.includes(`${pons.distribution.in_profit_pct.toFixed(1)}%`));
  assert.ok(readme.includes(`$${commas(rwa.distribution.percentiles['100'])}`));
});

test('the constraints the README leads with are the ones the build enforces', () => {
  // Round-trips only, nothing estimated, and the gas subsidy. If any of these stops being
  // true the README is the first thing that has to change.
  assert.match(readme, /out of scope, not estimated/);
  assert.match(readme, /first-in-first-out/);
  assert.match(readme, /`tx\.from`, never `Swap\.sender`/);
  assert.match(readme, /2026-09-29/);
  assert.ok(all.coverage.note.includes('out of scope, not estimated'),
    'the build no longer ships the claim the README repeats');
});

test('measured figures that cannot come from the store are pinned', () => {
  // Changing one of these should be a deliberate edit, not a drift.
  for (const figure of ['440,211', '20 of 20', '0.04%', '72,236', '52.6%']) {
    assert.ok(readme.includes(figure), `README lost the ${figure} verification figure`);
  }
  // And it says which number superseded which, rather than silently replacing it.
  assert.match(readme, /94,368/);
});

test('the README points at the other documents rather than restating them', () => {
  assert.match(readme, /\[STORE\.md\]\(STORE\.md\)/);
  assert.match(readme, /\[RAILWAY\.md\]\(RAILWAY\.md\)/);
  // The deploy specifics belong in RAILWAY.md; the README must not grow its own copy.
  for (const leaked of ['railway volume browse', 'PEAPOD_CYCLE_MINUTES', 'mount path']) {
    assert.ok(!readme.includes(leaked), `deploy detail "${leaked}" leaked into the README`);
  }
});
