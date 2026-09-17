/**
 * The two figures this data supports that the frames asked for in account-level terms.
 *
 * The design wants Max drawdown and ROI. Both are account-level: they need the value of
 * everything an address holds, over time, which needs the transfer index. These are not
 * those, they are not labelled as those, and the tests below hold the difference — because
 * the way this goes wrong is not a wrong number, it is a right number under a name that
 * means something else.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FIGURE_NOTES, realizedDrawdown, returnOnMatchedCost } from '../web/lib/figures.js';
import { detail, sample } from './store.mjs';

test('realized drawdown is the deepest fall of the closed-round-trip curve', () => {
  // Hand-checked cases first, so the property against the store is not the only thing
  // holding this up.
  assert.equal(realizedDrawdown([[1, 10], [2, 4], [3, 12]]).depth, 6);
  assert.equal(realizedDrawdown([[1, 5], [2, 9]]).depth, 0, 'a curve that only rises has no drawdown');
  // The curve starts at zero, so an address that only ever lost is in drawdown from its
  // first close. Reporting nothing there would flatter it.
  assert.equal(realizedDrawdown([[1, -3], [2, -9]]).depth, 9);
  assert.equal(realizedDrawdown([]).depth, 0);
  const deep = realizedDrawdown([[1, 10], [2, 4], [3, 12], [4, 1]]);
  assert.equal(deep.depth, 11, 'the deepest fall is not the first one');
  assert.deepEqual([deep.fromTs, deep.toTs], [3, 4]);

  // The build's own figure wins over the curve, because the curve is downsampled.
  const shipped = realizedDrawdown([[1, 10], [2, 9]],
    { realized_drawdown: { depth: 99, peak: 120, trough: 21, from_ts: 1, to_ts: 2, closes: 900 } });
  assert.deepEqual([shipped.depth, shipped.closes, shipped.exact], [99, 900, true]);
});

test('the build computes the drawdown over every close, not over the drawn curve', () => {
  // THE REASON THIS LIVES IN THE BUILD. The shipped series is thinned to 500 points, and a
  // sample can step straight over the trough, so a figure taken from it is a floor. Every
  // address with more closes than that must carry the build's own figure.
  const heavy = sample({ where: 'round_trips > 600', limit: 3 });
  assert.ok(heavy.length, 'no address in the store exercises the cap');
  for (const d of heavy) {
    const shipped = d.summary.realized_drawdown;
    assert.ok(shipped, `${d.address} ships no realized_drawdown; the build stopped computing it`);
    assert.equal(shipped.closes, d.summary.round_trips, 'the figure is not measured over every close');
    assert.ok(d.series.length < d.summary.round_trips, 'this address no longer exercises the cap');
    const fromCurve = realizedDrawdown(d.series, { round_trips: d.summary.round_trips });
    assert.equal(fromCurve.exact, false, 'a thinned curve is being reported as exact');
    // The floor is a floor: the build's figure can only be deeper.
    assert.ok(shipped.depth >= fromCurve.depth - 1e-6,
      `the sampled curve found a deeper fall (${fromCurve.depth}) than the build (${shipped.depth})`);
  }
});

test('return on matched cost divides by the cost the build actually matched', () => {
  // matched_volume is cost + proceeds and realized is proceeds − cost, so the cost is exact.
  // Checked against the per-round-trip list for addresses whose list is complete — the only
  // place the two can be compared.
  let checked = 0;
  for (const d of sample({ where: 'round_trips between 3 and 150', limit: 8 })) {
    const r = returnOnMatchedCost(d.summary);
    assert.ok(r, `no figure for an address with ${d.summary.round_trips} closes`);
    if (d.round_trips.length !== d.summary.round_trips) continue; // capped list; not comparable
    const listCost = d.round_trips.reduce((/** @type {number} */ a, /** @type {any} */ t) => a + t.qty * t.buy, 0);
    assert.ok(Math.abs(r.cost - listCost) < Math.max(1e-6, listCost * 1e-9),
      `cost ${r.cost} does not match the round-trips' own ${listCost}`);
    // It is a return on COST, not on volume: dividing by matched volume would roughly halve
    // it and mean something else.
    assert.notEqual(r.cost, d.summary.matched_volume);
    checked += 1;
  }
  assert.ok(checked > 0, 'no uncapped address was available to check the cost against');
  // A missing figure, never a zero.
  assert.equal(returnOnMatchedCost({ realized: 0, matched_volume: 0 }), null);
  assert.equal(returnOnMatchedCost(/** @type {any} */ ({})), null);
});

test('both figures say in words what they are not', () => {
  assert.match(FIGURE_NOTES.realizedDrawdown, /Not account drawdown/);
  assert.match(FIGURE_NOTES.returnOnMatchedCost, /Not account ROI/);
  assert.match(FIGURE_NOTES.realizedDrawdownSampled, /floor/);
});

test('the shipped store carries what both figures need', () => {
  const one = sample({ where: 'round_trips > 5', limit: 1 })[0];
  const full = detail(one.address);
  assert.ok(Number.isFinite(full.summary.matched_volume));
  assert.ok(Number.isFinite(full.summary.realized));
  assert.ok(full.series.length > 1, 'the realized curve is gone from the payload');
});
