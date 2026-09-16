"""Concentrated-liquidity math, ported 1:1 from Uniswap v4-core.

VENDORED FROM lp-terminal/engine/liquidity_math.py, unmodified below this notice.

It lived in another checkout on one laptop, which meant the deployed container could
never run a cycle: every stage that touched the band arithmetic died on an import.
peapod's own BigInt port in web/engine/liquidity-math.js is checked against THIS file by
test/parity, so vendoring it does not fork the source of truth — it puts the thing the
parity fixtures already pin next to them. Regenerate with:

    cp $PEAPOD_LP_TERMINAL/engine/liquidity_math.py engine/liquidity_math.py


Every function mirrors a specific v4-core source function, including its rounding
direction and sign convention. Ported from contracts/lib/v4-core @ v4.0.0:
  - TickMath.getSqrtPriceAtTick
  - SqrtPriceMath.getAmount0Delta / getAmount1Delta  (both unsigned and signed forms)
  - Pool.modifyLiquidity                             (the three-branch position split)

Python ints are arbitrary precision, so the Solidity `unchecked` intermediate products
are reproduced exactly; the uint256 wrap in getSqrtPriceAtTick is applied explicitly.

Rounding is not cosmetic here. v4 rounds *against* the LP when liquidity is added and
*toward* the pool when it is removed, so a naive float port drifts by a wei per call and
compounds across a backtest. Parity with these exact integers is what
contracts/test/LiquidityParity.t.sol asserts.
"""

from __future__ import annotations

UINT256_MAX = (1 << 256) - 1
Q96 = 1 << 96
RESOLUTION = 96

MIN_TICK = -887272
MAX_TICK = 887272
MIN_SQRT_PRICE = 4295128739
MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342


class InvalidTick(ValueError):
    pass


class InvalidPrice(ValueError):
    pass


def _div_rounding_up(a: int, b: int) -> int:
    """UnsafeMath.divRoundingUp"""
    return -(-a // b)


def mul_div(a: int, b: int, denominator: int) -> int:
    """FullMath.mulDiv — floor((a*b)/denominator), full 512-bit intermediate."""
    if denominator == 0:
        raise ZeroDivisionError("mulDiv by zero")
    result = (a * b) // denominator
    if result > UINT256_MAX:
        raise OverflowError("mulDiv overflow")
    return result


def mul_div_rounding_up(a: int, b: int, denominator: int) -> int:
    """FullMath.mulDivRoundingUp — ceil((a*b)/denominator)."""
    if denominator == 0:
        raise ZeroDivisionError("mulDivRoundingUp by zero")
    result = -(-(a * b) // denominator)
    if result > UINT256_MAX:
        raise OverflowError("mulDivRoundingUp overflow")
    return result


# Per-bit multipliers from TickMath. Each is round(2**128 / sqrt(1.0001**(2**i))).
_TICK_MULTIPLIERS = [
    (0x2, 0xFFF97272373D413259A46990580E213A),
    (0x4, 0xFFF2E50F5F656932EF12357CF3C7FDCC),
    (0x8, 0xFFE5CACA7E10E4E61C3624EAA0941CD0),
    (0x10, 0xFFCB9843D60F6159C9DB58835C926644),
    (0x20, 0xFF973B41FA98C081472E6896DFB254C0),
    (0x40, 0xFF2EA16466C96A3843EC78B326B52861),
    (0x80, 0xFE5DEE046A99A2A811C461F1969C3053),
    (0x100, 0xFCBE86C7900A88AEDCFFC83B479AA3A4),
    (0x200, 0xF987A7253AC413176F2B074CF7815E54),
    (0x400, 0xF3392B0822B70005940C7A398E4B70F3),
    (0x800, 0xE7159475A2C29B7443B29C7FA6E889D9),
    (0x1000, 0xD097F3BDFD2022B8845AD8F792AA5825),
    (0x2000, 0xA9F746462D870FDF8A65DC1F90E061E5),
    (0x4000, 0x70D869A156D2A1B890BB3DF62BAF32F7),
    (0x8000, 0x31BE135F97D08FD981231505542FCFA6),
    (0x10000, 0x9AA508B5B7A84E1C677DE54F3E99BC9),
    (0x20000, 0x5D6AF8DEDB81196699C329225EE604),
    (0x40000, 0x2216E584F5FA1EA926041BEDFE98),
    (0x80000, 0x48A170391F7DC42444E8FA2),
]


def get_sqrt_price_at_tick(tick: int) -> int:
    """TickMath.getSqrtPriceAtTick — the Q64.96 sqrt price at a tick."""
    abs_tick = -tick if tick < 0 else tick
    if abs_tick > MAX_TICK:
        raise InvalidTick(f"tick {tick} out of range")

    price = 0xFFFCB933BD6FAD37AA2D162D1A594001 if (abs_tick & 0x1) else (1 << 128)
    for bit, multiplier in _TICK_MULTIPLIERS:
        if abs_tick & bit:
            price = (price * multiplier) >> 128

    if tick > 0:
        price = UINT256_MAX // price

    # Q128.128 -> Q128.96, rounding up, so get_tick_at_sqrt_price stays consistent.
    return (price + ((1 << 32) - 1)) >> 32


def get_amount0_delta(sqrt_a: int, sqrt_b: int, liquidity: int, round_up: bool) -> int:
    """SqrtPriceMath.getAmount0Delta (unsigned). liquidity is uint128."""
    if sqrt_a > sqrt_b:
        sqrt_a, sqrt_b = sqrt_b, sqrt_a
    if sqrt_a == 0:
        raise InvalidPrice("sqrtPriceA is zero")

    numerator1 = liquidity << RESOLUTION
    numerator2 = sqrt_b - sqrt_a

    if round_up:
        return _div_rounding_up(mul_div_rounding_up(numerator1, numerator2, sqrt_b), sqrt_a)
    return mul_div(numerator1, numerator2, sqrt_b) // sqrt_a


def get_amount1_delta(sqrt_a: int, sqrt_b: int, liquidity: int, round_up: bool) -> int:
    """SqrtPriceMath.getAmount1Delta (unsigned). liquidity is uint128."""
    numerator = sqrt_a - sqrt_b if sqrt_a >= sqrt_b else sqrt_b - sqrt_a
    amount1 = mul_div(liquidity, numerator, Q96)
    if round_up and (liquidity * numerator) % Q96 > 0:
        amount1 += 1
    return amount1


def get_amount0_delta_signed(sqrt_a: int, sqrt_b: int, liquidity_delta: int) -> int:
    """SqrtPriceMath.getAmount0Delta (signed).

    Removing liquidity rounds DOWN and returns positive (pool pays out);
    adding liquidity rounds UP and returns negative (LP pays in).
    """
    if liquidity_delta < 0:
        return get_amount0_delta(sqrt_a, sqrt_b, -liquidity_delta, False)
    return -get_amount0_delta(sqrt_a, sqrt_b, liquidity_delta, True)


def get_amount1_delta_signed(sqrt_a: int, sqrt_b: int, liquidity_delta: int) -> int:
    """SqrtPriceMath.getAmount1Delta (signed). Same convention as amount0."""
    if liquidity_delta < 0:
        return get_amount1_delta(sqrt_a, sqrt_b, -liquidity_delta, False)
    return -get_amount1_delta(sqrt_a, sqrt_b, liquidity_delta, True)


def modify_liquidity_delta(
    tick: int, sqrt_price_x96: int, tick_lower: int, tick_upper: int, liquidity_delta: int
) -> tuple[int, int]:
    """Pool.modifyLiquidity — the BalanceDelta for a liquidity change.

    Returns (amount0, amount1), signed with v4's convention: negative means the LP owes
    the pool. Branches on the stored slot0 `tick`, not on a sqrt-price comparison —
    matching v4-core exactly, which matters at a range boundary.
    """
    if liquidity_delta == 0:
        return (0, 0)

    sqrt_lower = get_sqrt_price_at_tick(tick_lower)
    sqrt_upper = get_sqrt_price_at_tick(tick_upper)

    if tick < tick_lower:
        return (get_amount0_delta_signed(sqrt_lower, sqrt_upper, liquidity_delta), 0)
    if tick < tick_upper:
        return (
            get_amount0_delta_signed(sqrt_price_x96, sqrt_upper, liquidity_delta),
            get_amount1_delta_signed(sqrt_lower, sqrt_price_x96, liquidity_delta),
        )
    return (0, get_amount1_delta_signed(sqrt_lower, sqrt_upper, liquidity_delta))


def position_amounts(
    tick: int, sqrt_price_x96: int, tick_lower: int, tick_upper: int, liquidity: int
) -> tuple[int, int]:
    """Token amounts a position of `liquidity` is currently worth.

    The magnitude of withdrawing the whole position, so it rounds DOWN — the
    conservative direction for valuing an LP position.
    """
    a0, a1 = modify_liquidity_delta(tick, sqrt_price_x96, tick_lower, tick_upper, -liquidity)
    return (a0, a1)
