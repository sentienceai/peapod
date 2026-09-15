/**
 * Parity gate for the BigInt engine.
 *
 * `fixtures/positions.json` is byte-identical to lp-terminal's
 * `contracts/test/fixtures/positions.json` — 20 real Robinhood Chain ModifyLiquidity
 * events, each paired with the pool's exact price at that moment (the sqrtPriceX96/tick
 * left by the most recent preceding Swap in the same pool, which is exact because
 * ModifyLiquidity does not move the price).
 *
 * lp-terminal's `LiquidityParity.t.sol` asserts those same expected amounts against
 * canonical v4-core through PoolMathHarness, requiring EXACT integer agreement. These
 * tests mirror all three of its assertions against the JS port, so a green run here plus
 * a green `forge test` there means: JS == Python == v4-core, on the same 20 positions.
 *
 * These are deterministic integer operations. Any drift is a bug, not rounding.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  MIN_TICK,
  MAX_TICK,
  MIN_SQRT_PRICE,
  MAX_SQRT_PRICE,
  getSqrtPriceAtTick,
  modifyLiquidityDelta,
} from '../web/engine/liquidity-math.js';

/**
 * @typedef {object} Position
 * @property {string} label
 * @property {string} poolId
 * @property {number} block
 * @property {string} txHash
 * @property {number} tick
 * @property {string} sqrtPriceX96
 * @property {number} tickLower
 * @property {number} tickUpper
 * @property {string} liquidityDelta
 * @property {string} expectedAmount0
 * @property {string} expectedAmount1
 */

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/positions.json', import.meta.url), 'utf8'),
);
/** @type {Position[]} */
const positions = fixture.positions;

test('fixture is the 20 real historical positions', () => {
  assert.equal(fixture.count, 20, 'expected 20 real historical positions');
  assert.equal(positions.length, 20);
});

test('parity against v4-core on all 20 positions', () => {
  for (const p of positions) {
    const [got0, got1] = modifyLiquidityDelta(
      p.tick,
      BigInt(p.sqrtPriceX96),
      p.tickLower,
      p.tickUpper,
      BigInt(p.liquidityDelta),
    );
    assert.equal(got0, BigInt(p.expectedAmount0), `amount0 mismatch @ ${p.label}`);
    assert.equal(got1, BigInt(p.expectedAmount1), `amount1 mismatch @ ${p.label}`);
  }
});

test('tick math parity: spec anchors', () => {
  assert.equal(getSqrtPriceAtTick(0), 79228162514264337593543950336n, 'tick 0');
  assert.equal(getSqrtPriceAtTick(MIN_TICK), MIN_SQRT_PRICE, 'MIN_TICK');
  assert.equal(getSqrtPriceAtTick(MAX_TICK), MAX_SQRT_PRICE, 'MAX_TICK');
});

test('tick math parity: every real price sits inside its own tick', () => {
  for (const p of positions) {
    const sqrtPriceX96 = BigInt(p.sqrtPriceX96);
    assert.ok(
      sqrtPriceX96 >= getSqrtPriceAtTick(p.tick),
      `price below its own tick @ ${p.label}`,
    );
    assert.ok(
      sqrtPriceX96 < getSqrtPriceAtTick(p.tick + 1),
      `price above its own tick @ ${p.label}`,
    );
  }
});

test('rounding favours the pool, never the LP', () => {
  // Adding liquidity must cost the LP at least what removing the same liquidity
  // returns. A float port silently breaks this; that is the whole reason for BigInt.
  for (const p of positions) {
    const delta = BigInt(p.liquidityDelta);
    const mag = delta < 0n ? -delta : delta;
    const sqrtPriceX96 = BigInt(p.sqrtPriceX96);

    const [add0, add1] = modifyLiquidityDelta(p.tick, sqrtPriceX96, p.tickLower, p.tickUpper, mag);
    const [rem0, rem1] = modifyLiquidityDelta(p.tick, sqrtPriceX96, p.tickLower, p.tickUpper, -mag);

    assert.ok(-add0 <= (rem0 === 0n ? 0n : rem0 + 1n), `amount0 round-trip leaks value to LP @ ${p.label}`);
    assert.ok(-add0 >= rem0, `amount0: adding must cost >= removing returns @ ${p.label}`);
    assert.ok(-add1 >= rem1, `amount1: adding must cost >= removing returns @ ${p.label}`);
  }
});

test('zero liquidity delta is a no-op', () => {
  assert.deepEqual(modifyLiquidityDelta(0, getSqrtPriceAtTick(0), -60, 60, 0n), [0n, 0n]);
});

test('out-of-range ticks are rejected, not silently clamped', () => {
  assert.throws(() => getSqrtPriceAtTick(MAX_TICK + 1));
  assert.throws(() => getSqrtPriceAtTick(MIN_TICK - 1));
});
