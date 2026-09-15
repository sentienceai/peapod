/**
 * Full-domain parity for the tick and delta functions, against canonical v4-core.
 *
 * `positions.json` pins `modifyLiquidityDelta` on 20 real positions, but it does not pin
 * `getSqrtPriceAtTick`: those positions are mostly full-range (so the bounds are MIN/MAX
 * tick) and their `sqrtPriceX96` comes straight from the event rather than from a tick.
 * A corrupted per-bit multiplier passes all 20 fixtures while changing the sqrt price at
 * 6,898 of 18,295 ticks. These sweeps close that hole.
 *
 * Both fixtures were emitted by `tools/parity/Sweep.t.sol` calling v4-core's own
 * TickMath and SqrtPriceMath, so this is JS-against-v4-core directly, not JS against a
 * second copy of the same port.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  getSqrtPriceAtTick,
  getAmount0Delta,
  getAmount1Delta,
} from '../web/engine/liquidity-math.js';

/** @param {string} name */
async function fixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

const tickSweep = await fixture('tick-sweep.json');
const deltaSweep = await fixture('delta-sweep.json');

test('tick sweep covers the domain it claims to', () => {
  /** @type {{tick: number, sqrtPriceX96: string}[]} */
  const cases = tickSweep.cases;
  assert.ok(cases.length >= 400, `expected a broad sweep, got ${cases.length} cases`);

  // Every per-bit multiplier must be exercised by at least one sampled tick, in both
  // signs — that is precisely what positions.json fails to do.
  for (let i = 0; i < 20; i++) {
    const bit = 1 << i;
    assert.ok(
      cases.some((c) => c.tick > 0 && Math.abs(c.tick) & bit),
      `no positive tick exercises multiplier bit 0x${bit.toString(16)}`,
    );
    assert.ok(
      cases.some((c) => c.tick < 0 && Math.abs(c.tick) & bit),
      `no negative tick exercises multiplier bit 0x${bit.toString(16)}`,
    );
  }
});

test('getSqrtPriceAtTick matches v4-core across the sweep', () => {
  /** @type {{tick: number, sqrtPriceX96: string}[]} */
  const cases = tickSweep.cases;
  for (const c of cases) {
    assert.equal(
      getSqrtPriceAtTick(c.tick),
      BigInt(c.sqrtPriceX96),
      `sqrtPriceX96 mismatch @ tick ${c.tick}`,
    );
  }
});

test('getSqrtPriceAtTick is strictly monotonic across the sweep', () => {
  /** @type {{tick: number}[]} */
  const cases = tickSweep.cases;
  const ticks = [...new Set(cases.map((c) => c.tick))].sort((a, b) => a - b);
  for (let i = 1; i < ticks.length; i++) {
    assert.ok(
      getSqrtPriceAtTick(ticks[i]) > getSqrtPriceAtTick(ticks[i - 1]),
      `not monotonic between ticks ${ticks[i - 1]} and ${ticks[i]}`,
    );
  }
});

test('getAmount0Delta / getAmount1Delta match v4-core across the sweep', () => {
  /** @type {{sqrtA: string, sqrtB: string, liquidity: string, roundUp: boolean, amount0: string, amount1: string}[]} */
  const cases = deltaSweep.cases;
  assert.ok(cases.length >= 200, `expected a broad sweep, got ${cases.length} cases`);

  for (const c of cases) {
    const sqrtA = BigInt(c.sqrtA);
    const sqrtB = BigInt(c.sqrtB);
    const liquidity = BigInt(c.liquidity);
    const where = `sqrtA=${c.sqrtA} sqrtB=${c.sqrtB} L=${c.liquidity} roundUp=${c.roundUp}`;

    assert.equal(getAmount0Delta(sqrtA, sqrtB, liquidity, c.roundUp), BigInt(c.amount0), `amount0 mismatch @ ${where}`);
    assert.equal(getAmount1Delta(sqrtA, sqrtB, liquidity, c.roundUp), BigInt(c.amount1), `amount1 mismatch @ ${where}`);
  }
});

test('rounding up never returns less than rounding down', () => {
  /** @type {{sqrtA: string, sqrtB: string, liquidity: string}[]} */
  const cases = deltaSweep.cases;
  for (const c of cases) {
    const sqrtA = BigInt(c.sqrtA);
    const sqrtB = BigInt(c.sqrtB);
    const liquidity = BigInt(c.liquidity);
    assert.ok(getAmount0Delta(sqrtA, sqrtB, liquidity, true) >= getAmount0Delta(sqrtA, sqrtB, liquidity, false));
    assert.ok(getAmount1Delta(sqrtA, sqrtB, liquidity, true) >= getAmount1Delta(sqrtA, sqrtB, liquidity, false));
    // and never by more than one wei
    assert.ok(getAmount0Delta(sqrtA, sqrtB, liquidity, true) - getAmount0Delta(sqrtA, sqrtB, liquidity, false) <= 1n);
    assert.ok(getAmount1Delta(sqrtA, sqrtB, liquidity, true) - getAmount1Delta(sqrtA, sqrtB, liquidity, false) <= 1n);
  }
});

test('delta functions are symmetric in their price arguments', () => {
  // Both functions document that they order sqrtA/sqrtB themselves. No call site inside
  // this module passes them reversed, so nothing else would catch the guard going missing
  // — but the calculator calls these directly to value a depth band, so pin the contract.
  /** @type {{sqrtA: string, sqrtB: string, liquidity: string, roundUp: boolean}[]} */
  const cases = deltaSweep.cases;
  for (const c of cases) {
    const sqrtA = BigInt(c.sqrtA);
    const sqrtB = BigInt(c.sqrtB);
    const liquidity = BigInt(c.liquidity);
    const where = `sqrtA=${c.sqrtA} sqrtB=${c.sqrtB} L=${c.liquidity}`;
    assert.equal(
      getAmount0Delta(sqrtB, sqrtA, liquidity, c.roundUp),
      getAmount0Delta(sqrtA, sqrtB, liquidity, c.roundUp),
      `amount0 not symmetric @ ${where}`,
    );
    assert.equal(
      getAmount1Delta(sqrtB, sqrtA, liquidity, c.roundUp),
      getAmount1Delta(sqrtA, sqrtB, liquidity, c.roundUp),
      `amount1 not symmetric @ ${where}`,
    );
  }
});
