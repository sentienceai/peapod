/**
 * Concentrated-liquidity math, ported 1:1 from Uniswap v4-core via lp-terminal's
 * `engine/liquidity_math.py`.
 *
 * Every function mirrors a specific v4-core source function, including its rounding
 * direction and sign convention. Ported from v4-core @ v4.0.0:
 *   - TickMath.getSqrtPriceAtTick
 *   - SqrtPriceMath.getAmount0Delta / getAmount1Delta  (unsigned and signed forms)
 *   - Pool.modifyLiquidity                             (the three-branch position split)
 *
 * WHY BIGINT, NOT NUMBER. Rounding is not cosmetic here. v4 rounds *against* the LP when
 * liquidity is added and *toward* the pool when it is removed, so a float port drifts by
 * a wei per call and compounds across a backtest. Every value below is an exact integer;
 * there is no Number arithmetic anywhere in this file.
 *
 * WHY THIS FILE SHIPS UNBUILT. `test/liquidity-math.test.mjs` asserts this module against
 * `test/fixtures/positions.json` — the same 20 real Robinhood Chain positions that
 * lp-terminal's `contracts/test/LiquidityParity.t.sol` asserts against canonical v4-core.
 * peapod has no build step, so the file the parity test proves correct is byte-for-byte
 * the file the browser loads. Do not introduce a transform between the two.
 *
 * PYTHON/JS DIVISION. Python's `//` floors; BigInt `/` truncates toward zero. They agree
 * only on non-negative operands. Every division in the ported algorithms operates on
 * non-negative values, and `floorDiv`/`ceilDiv` below reject negative input so a future
 * caller fails loudly instead of diverging silently from the Python and the Solidity.
 */

export const UINT256_MAX = (1n << 256n) - 1n;
export const Q96 = 1n << 96n;
export const RESOLUTION = 96n;

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

/** Raised for a tick outside [MIN_TICK, MAX_TICK]. */
export class InvalidTick extends Error {}
/** Raised for a zero or negative sqrt price. */
export class InvalidPrice extends Error {}
/** Raised when an intermediate exceeds uint256, as the Solidity would revert. */
export class Overflow extends Error {}

/**
 * floor(a / b) for non-negative a and positive b — Python's `a // b` on that domain.
 * @param {bigint} a
 * @param {bigint} b
 * @returns {bigint}
 */
function floorDiv(a, b) {
  if (a < 0n || b <= 0n) throw new RangeError(`floorDiv domain: ${a} / ${b}`);
  return a / b;
}

/**
 * ceil(a / b) for non-negative a and positive b — Python's `-(-a // b)` on that domain,
 * which is v4-core's UnsafeMath.divRoundingUp.
 * @param {bigint} a
 * @param {bigint} b
 * @returns {bigint}
 */
function ceilDiv(a, b) {
  if (a < 0n || b <= 0n) throw new RangeError(`ceilDiv domain: ${a} / ${b}`);
  return a === 0n ? 0n : (a + b - 1n) / b;
}

/**
 * FullMath.mulDiv — floor((a*b)/denominator), full 512-bit intermediate.
 * @param {bigint} a
 * @param {bigint} b
 * @param {bigint} denominator
 * @returns {bigint}
 */
export function mulDiv(a, b, denominator) {
  if (denominator === 0n) throw new RangeError('mulDiv by zero');
  const result = floorDiv(a * b, denominator);
  if (result > UINT256_MAX) throw new Overflow('mulDiv overflow');
  return result;
}

/**
 * FullMath.mulDivRoundingUp — ceil((a*b)/denominator).
 * @param {bigint} a
 * @param {bigint} b
 * @param {bigint} denominator
 * @returns {bigint}
 */
export function mulDivRoundingUp(a, b, denominator) {
  if (denominator === 0n) throw new RangeError('mulDivRoundingUp by zero');
  const result = ceilDiv(a * b, denominator);
  if (result > UINT256_MAX) throw new Overflow('mulDivRoundingUp overflow');
  return result;
}

/**
 * Per-bit multipliers from TickMath. Each is round(2**128 / sqrt(1.0001**(2**i))).
 * @type {ReadonlyArray<readonly [bigint, bigint]>}
 */
const TICK_MULTIPLIERS = [
  [0x2n, 0xfff97272373d413259a46990580e213an],
  [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000n, 0x48a170391f7dc42444e8fa2n],
];

/**
 * TickMath.getSqrtPriceAtTick — the Q64.96 sqrt price at a tick.
 * @param {number} tick
 * @returns {bigint}
 */
export function getSqrtPriceAtTick(tick) {
  if (!Number.isInteger(tick)) throw new InvalidTick(`tick ${tick} is not an integer`);
  const absTick = BigInt(tick < 0 ? -tick : tick);
  if (absTick > BigInt(MAX_TICK)) throw new InvalidTick(`tick ${tick} out of range`);

  let price = (absTick & 0x1n) ? 0xfffcb933bd6fad37aa2d162d1a594001n : (1n << 128n);
  for (const [bit, multiplier] of TICK_MULTIPLIERS) {
    if (absTick & bit) price = (price * multiplier) >> 128n;
  }

  if (tick > 0) price = floorDiv(UINT256_MAX, price);

  // Q128.128 -> Q128.96, rounding up, so getTickAtSqrtPrice stays consistent.
  return (price + ((1n << 32n) - 1n)) >> 32n;
}

/**
 * SqrtPriceMath.getAmount0Delta (unsigned). `liquidity` is a uint128 magnitude.
 * @param {bigint} sqrtA
 * @param {bigint} sqrtB
 * @param {bigint} liquidity
 * @param {boolean} roundUp
 * @returns {bigint}
 */
export function getAmount0Delta(sqrtA, sqrtB, liquidity, roundUp) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtA === 0n) throw new InvalidPrice('sqrtPriceA is zero');

  const numerator1 = liquidity << RESOLUTION;
  const numerator2 = sqrtB - sqrtA;

  if (roundUp) {
    return ceilDiv(mulDivRoundingUp(numerator1, numerator2, sqrtB), sqrtA);
  }
  return floorDiv(mulDiv(numerator1, numerator2, sqrtB), sqrtA);
}

/**
 * SqrtPriceMath.getAmount1Delta (unsigned). `liquidity` is a uint128 magnitude.
 * @param {bigint} sqrtA
 * @param {bigint} sqrtB
 * @param {bigint} liquidity
 * @param {boolean} roundUp
 * @returns {bigint}
 */
export function getAmount1Delta(sqrtA, sqrtB, liquidity, roundUp) {
  const numerator = sqrtA >= sqrtB ? sqrtA - sqrtB : sqrtB - sqrtA;
  let amount1 = mulDiv(liquidity, numerator, Q96);
  if (roundUp && (liquidity * numerator) % Q96 > 0n) amount1 += 1n;
  return amount1;
}

/**
 * SqrtPriceMath.getAmount0Delta (signed).
 *
 * Removing liquidity rounds DOWN and returns positive (pool pays out);
 * adding liquidity rounds UP and returns negative (LP pays in).
 * @param {bigint} sqrtA
 * @param {bigint} sqrtB
 * @param {bigint} liquidityDelta
 * @returns {bigint}
 */
export function getAmount0DeltaSigned(sqrtA, sqrtB, liquidityDelta) {
  if (liquidityDelta < 0n) return getAmount0Delta(sqrtA, sqrtB, -liquidityDelta, false);
  return -getAmount0Delta(sqrtA, sqrtB, liquidityDelta, true);
}

/**
 * SqrtPriceMath.getAmount1Delta (signed). Same convention as amount0.
 * @param {bigint} sqrtA
 * @param {bigint} sqrtB
 * @param {bigint} liquidityDelta
 * @returns {bigint}
 */
export function getAmount1DeltaSigned(sqrtA, sqrtB, liquidityDelta) {
  if (liquidityDelta < 0n) return getAmount1Delta(sqrtA, sqrtB, -liquidityDelta, false);
  return -getAmount1Delta(sqrtA, sqrtB, liquidityDelta, true);
}

/**
 * Pool.modifyLiquidity — the BalanceDelta for a liquidity change.
 *
 * Returns [amount0, amount1], signed with v4's convention: negative means the LP owes
 * the pool. Branches on the stored slot0 `tick`, not on a sqrt-price comparison —
 * matching v4-core exactly, which matters at a range boundary.
 * @param {number} tick
 * @param {bigint} sqrtPriceX96
 * @param {number} tickLower
 * @param {number} tickUpper
 * @param {bigint} liquidityDelta
 * @returns {[bigint, bigint]}
 */
export function modifyLiquidityDelta(tick, sqrtPriceX96, tickLower, tickUpper, liquidityDelta) {
  if (liquidityDelta === 0n) return [0n, 0n];

  const sqrtLower = getSqrtPriceAtTick(tickLower);
  const sqrtUpper = getSqrtPriceAtTick(tickUpper);

  if (tick < tickLower) {
    return [getAmount0DeltaSigned(sqrtLower, sqrtUpper, liquidityDelta), 0n];
  }
  if (tick < tickUpper) {
    return [
      getAmount0DeltaSigned(sqrtPriceX96, sqrtUpper, liquidityDelta),
      getAmount1DeltaSigned(sqrtLower, sqrtPriceX96, liquidityDelta),
    ];
  }
  return [0n, getAmount1DeltaSigned(sqrtLower, sqrtUpper, liquidityDelta)];
}

/**
 * Token amounts a position of `liquidity` is currently worth.
 *
 * The magnitude of withdrawing the whole position, so it rounds DOWN — the
 * conservative direction for valuing an LP position.
 * @param {number} tick
 * @param {bigint} sqrtPriceX96
 * @param {number} tickLower
 * @param {number} tickUpper
 * @param {bigint} liquidity
 * @returns {[bigint, bigint]}
 */
export function positionAmounts(tick, sqrtPriceX96, tickLower, tickUpper, liquidity) {
  return modifyLiquidityDelta(tick, sqrtPriceX96, tickLower, tickUpper, -liquidity);
}
