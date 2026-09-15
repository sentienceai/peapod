"""+/-1% depth: the flat-L figure, and the tick-map walk that replaces it.

WHAT THE WALK REPLACES. lp-terminal's engine/depth_distribution.py values a pool's +/-1%
band with ONE liquidity value -- the active L under the current tick -- held flat across
the whole band. peapod headlines "real executable depth, not TVL", so it cannot ship that.

This walks the actual tick liquidity map: the band is split at every initialized tick the
price would cross, each segment valued with the liquidity genuinely active there.
Positions whose ranges end inside the band stop contributing where they end.

BOTH BASES ARE KEPT. Not as a hedge -- because the flat-L figure is what lp-terminal
published, and showing the two side by side is the only way a reader can see what changed.
lp-terminal calls flat-L an upper bound. It is not one. Liquidity can switch ON inside the
band as readily as off, and then real depth is larger: across pools with a real book the
executable/flat ratio runs p5=69%, p50=100%, p95=116%. It is a point estimate that errs in
both directions.
"""

from __future__ import annotations

import math
from collections import defaultdict

BAND = 0.01


def band_bounds(sqrt_p: int) -> tuple[int, int]:
    """The sqrt-price bounds of a +/-1% band, as depth_distribution.py computes them."""
    return (int(sqrt_p * math.sqrt(1 / (1 + BAND))), int(sqrt_p * math.sqrt(1 + BAND)))


def flat_band_depth(lm, sqrt_p: int, L: int, d0: int, d1: int, rwa0: bool, px: float) -> float:
    """depth_distribution.py's band_depth, unchanged, so the published number reproduces."""
    lo, hi = band_bounds(sqrt_p)
    a0 = lm.get_amount0_delta(sqrt_p, hi, L, False)
    a1 = lm.get_amount1_delta(lo, sqrt_p, L, False)
    rwa_amt = (a0 / 10 ** d0) if rwa0 else (a1 / 10 ** d1)
    usd_amt = (a1 / 10 ** d1) if rwa0 else (a0 / 10 ** d0)
    return rwa_amt * px + usd_amt


def walk_band_depth(lm, sqrt_p: int, tick_now: int, L0: int, ticks, net,
                    d0: int, d1: int, rwa0: bool, px: float) -> tuple[float, int, bool]:
    """Executable depth: split the band at every initialized tick and sum the segments.

    Crossing convention is Pool.swap's, the same one pool_state.PoolState.apply_swap and
    fee_attribution.split_swap_at_ticks use: going up, liquidity += liquidityNet[t] on
    crossing t; going down, liquidity -= liquidityNet[t]. Boundaries are compared in sqrt
    price, so a tick the price does not actually reach is not crossed.

    Returns (depth_usd, segments_walked, liquidity_stayed_non_negative).
    """
    lo, hi = band_bounds(sqrt_p)
    segments = 0
    sane = True

    # Upward: token0 the pool would sell as the price rises to +1%. Every initialized tick
    # with tick_now < t <= tick_at(hi) is crossed and its liquidityNet applied. A tick whose
    # boundary coincides with the current price opens no segment but MUST still be crossed
    # -- skipping the crossing leaves every later segment on the wrong liquidity.
    a0 = 0
    cur, L = sqrt_p, L0
    for t in ticks:
        if t <= tick_now:
            continue
        b = lm.get_sqrt_price_at_tick(t)
        if b > hi:
            break
        if b > cur:
            if L > 0:
                a0 += lm.get_amount0_delta(cur, b, L, False)
            segments += 1
            cur = b
        L += net[t]
        if L < 0:
            sane = False
            L = 0
    if cur < hi and L > 0:
        a0 += lm.get_amount0_delta(cur, hi, L, False)

    # Downward: token1 the pool would sell as the price falls to -1%. The ticks crossed are
    # those with tick_at(lo) < t <= tick_now -- note the inclusive upper end, so a tick
    # equal to the current tick IS crossed.
    a1 = 0
    cur, L = sqrt_p, L0
    for t in reversed(ticks):
        if t > tick_now:
            continue
        b = lm.get_sqrt_price_at_tick(t)
        if b < lo:
            break
        if b < cur:
            if L > 0:
                a1 += lm.get_amount1_delta(b, cur, L, False)
            segments += 1
            cur = b
        L -= net[t]
        if L < 0:
            sane = False
            L = 0
    if cur > lo and L > 0:
        a1 += lm.get_amount1_delta(lo, cur, L, False)

    rwa_amt = (a0 / 10 ** d0) if rwa0 else (a1 / 10 ** d1)
    usd_amt = (a1 / 10 ** d1) if rwa0 else (a0 / 10 ** d0)
    return rwa_amt * px + usd_amt, segments, sane


class TickMap:
    """A pool's liquidityNet map, advanced in block order and checked against the chain.

    Active liquidity at a tick is the sum of liquidityNet at or below it. Every Swap event
    carries the pool's real active liquidity, so `matches` compares the reconstruction
    against the chain at any swap. A map that fails that check is not used.
    """

    def __init__(self) -> None:
        self.net: dict[int, int] = defaultdict(int)
        self._ticks: list[int] | None = None

    def apply(self, tick_lower: int, tick_upper: int, liquidity_delta: int) -> None:
        if liquidity_delta == 0:
            return
        self.net[tick_lower] += liquidity_delta
        self.net[tick_upper] -= liquidity_delta
        self._ticks = None

    def active_at(self, tick: int) -> int:
        return sum(v for t, v in self.net.items() if t <= tick and v != 0)

    def matches(self, tick: int, reported_liquidity: int) -> bool:
        return self.active_at(tick) == reported_liquidity

    @property
    def ticks(self) -> list[int]:
        """Initialized ticks, ascending. Emptied ticks are dropped, as v4 prunes them."""
        if self._ticks is None:
            self._ticks = sorted(t for t, v in self.net.items() if v != 0)
        return self._ticks

    def depth(self, lm, sqrt_p, tick, L, d0, d1, rwa0, px):
        return walk_band_depth(lm, sqrt_p, tick, L, self.ticks, self.net, d0, d1, rwa0, px)
