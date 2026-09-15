/**
 * Range-boundary parity for Pool.modifyLiquidity's three-branch split.
 *
 * v4 branches on the stored slot0 `tick`, not on a sqrt-price comparison. When the price
 * sits strictly inside its own tick and that tick equals `tickLower` or `tickUpper`, the
 * wrong comparison returns a different — and plausible-looking — split of the position
 * into token0 and token1. `positions.json` contains no such case, so a `<` -> `<=` slip
 * survives all 20 of its fixtures.
 *
 * Fixtures come from `tools/parity/Sweep.t.sol` calling lp-terminal's PoolMathHarness,
 * the transcription of Pool.modifyLiquidity that `LiquidityParity.t.sol` pins against
 * v4-core. Every case is emitted twice: once with the price exactly at its tick, once
 * nudged strictly inside it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { getSqrtPriceAtTick, modifyLiquidityDelta, positionAmounts } from '../web/engine/liquidity-math.js';

/**
 * @typedef {object} BoundaryCase
 * @property {number} tick
 * @property {string} sqrtPriceX96
 * @property {number} tickLower
 * @property {number} tickUpper
 * @property {string} liquidity
 * @property {string} add0
 * @property {string} add1
 * @property {string} remove0
 * @property {string} remove1
 */

const sweep = JSON.parse(
  await readFile(new URL('./fixtures/boundary-sweep.json', import.meta.url), 'utf8'),
);
/** @type {BoundaryCase[]} */
const cases = sweep.cases;

test('boundary sweep actually straddles the branch edges', () => {
  assert.ok(cases.length >= 100, `expected a broad sweep, got ${cases.length} cases`);
  assert.ok(cases.some((c) => c.tick === c.tickLower), 'no case with tick == tickLower');
  assert.ok(cases.some((c) => c.tick === c.tickUpper), 'no case with tick == tickUpper');
  // The distinguishing cases: tick sits on a bound AND the price is strictly inside it.
  const strictlyInside = cases.filter(
    (c) => (c.tick === c.tickLower || c.tick === c.tickUpper) &&
      BigInt(c.sqrtPriceX96) > getSqrtPriceAtTick(c.tick),
  );
  assert.ok(strictlyInside.length > 0, 'no case pins tick-vs-price-comparison branching');
});

test('modifyLiquidityDelta matches v4-core at every range boundary', () => {
  for (const c of cases) {
    const sqrtPriceX96 = BigInt(c.sqrtPriceX96);
    const liquidity = BigInt(c.liquidity);
    const where = `tick=${c.tick} range=[${c.tickLower},${c.tickUpper}] price=${c.sqrtPriceX96}`;

    const [add0, add1] = modifyLiquidityDelta(c.tick, sqrtPriceX96, c.tickLower, c.tickUpper, liquidity);
    assert.equal(add0, BigInt(c.add0), `add amount0 mismatch @ ${where}`);
    assert.equal(add1, BigInt(c.add1), `add amount1 mismatch @ ${where}`);

    const [rem0, rem1] = modifyLiquidityDelta(c.tick, sqrtPriceX96, c.tickLower, c.tickUpper, -liquidity);
    assert.equal(rem0, BigInt(c.remove0), `remove amount0 mismatch @ ${where}`);
    assert.equal(rem1, BigInt(c.remove1), `remove amount1 mismatch @ ${where}`);
  }
});

test('positionAmounts is the removal magnitude', () => {
  for (const c of cases) {
    const sqrtPriceX96 = BigInt(c.sqrtPriceX96);
    const liquidity = BigInt(c.liquidity);
    const [a0, a1] = positionAmounts(c.tick, sqrtPriceX96, c.tickLower, c.tickUpper, liquidity);
    assert.equal(a0, BigInt(c.remove0));
    assert.equal(a1, BigInt(c.remove1));
    // Valuing a position must never invent tokens.
    assert.ok(a0 >= 0n && a1 >= 0n, `negative position value @ tick=${c.tick}`);
  }
});

test('a position below its range is all token0, above its range all token1', () => {
  for (const c of cases) {
    if (c.tick < c.tickLower) {
      assert.equal(BigInt(c.add1), 0n, `token1 owed below range @ tick=${c.tick}`);
    } else if (c.tick >= c.tickUpper) {
      assert.equal(BigInt(c.add0), 0n, `token0 owed above range @ tick=${c.tick}`);
    }
  }
});
