"""Regression tests for the +/-1% band walk.

The walk is the one piece of genuinely new logic in peapod's depth number, and it is not
covered by the v4-core parity fixtures: those pin the math it calls, not the traversal.
Case 5 is the one that matters -- an independent one-tick-at-a-time reimplementation, the
slowest correct thing, checked against the real walk. It caught a crossing bug the first
time it ran: a tick whose boundary coincides with the current price was skipped rather
than crossed, so its liquidityNet was never applied and every later segment ran on the
wrong liquidity.

Usage:  PEAPOD_LP_TERMINAL=~/lp-terminal uv run pytest export/
"""

from __future__ import annotations

import math
import sys
import unittest

import bandwalk as E
from upstream import engine

lm, _LP_ROOT, _CASES = engine()
get_sqrt_price_at_tick = lm.get_sqrt_price_at_tick
get_amount0_delta = lm.get_amount0_delta
get_amount1_delta = lm.get_amount1_delta

SP = get_sqrt_price_at_tick(0)
TICK = 0
L = 10 ** 18
D0 = D1 = 18
RWA0 = True
PX = 1.0
# +/-1% is about +/-99 ticks, since 1.0001**99 ~= 1.00995.
IN_BAND = 50
OUT_OF_BAND = 50_000


def walk(net):
    depth, segments, sane = E.walk_band_depth(
        lm, SP, TICK, L, sorted(net), net, D0, D1, RWA0, PX)
    return depth, segments, sane


def brute(net):
    """One tick at a time, no shortcuts. Deliberately the slow, obvious implementation.

    It scans EVERY tick in the band rather than iterating the sorted map, so it derives
    the crossings independently -- which is the part the walk gets wrong when it gets
    anything wrong. It closes a segment only where liquidity actually changes, matching
    v4, which likewise only splits a swap at initialized ticks. Splitting at every tick
    instead would truncate each piece separately and land a few wei low, measuring a
    different quantity rather than checking this one.
    """
    lo = int(SP * math.sqrt(1 / 1.01))
    hi = int(SP * math.sqrt(1.01))

    a0, liq, cur, t = 0, L, SP, TICK
    while True:
        t += 1
        b = get_sqrt_price_at_tick(t)
        if b > hi:
            break
        if net.get(t, 0) != 0:
            if b > cur:
                a0 += get_amount0_delta(cur, b, liq, False)
                cur = b
            liq += net[t]
    if cur < hi:
        a0 += get_amount0_delta(cur, hi, liq, False)

    a1, liq, cur, t = 0, L, SP, TICK + 1
    while True:
        t -= 1
        b = get_sqrt_price_at_tick(t)
        if b < lo:
            break
        if net.get(t, 0) != 0:
            if b < cur:
                a1 += get_amount1_delta(b, cur, liq, False)
                cur = b
            liq -= net[t]
    if cur > lo:
        a1 += get_amount1_delta(lo, cur, liq, False)

    return a0 / 10 ** D0 * PX + a1 / 10 ** D1


class BandWalk(unittest.TestCase):
    def setUp(self):
        self.flat = E.flat_band_depth(lm, SP, L, D0, D1, RWA0, PX)

    def test_empty_map_equals_flat_exactly(self):
        # With no initialized ticks there is nothing to cross, so the walk must reduce to
        # the flat-L formula bit for bit -- not merely close to it.
        depth, segments, _ = walk({})
        self.assertEqual(depth, self.flat)
        self.assertEqual(segments, 0)

    def test_ticks_outside_the_band_are_not_crossed(self):
        depth, segments, _ = walk({-OUT_OF_BAND: 10 ** 17, OUT_OF_BAND: -(10 ** 17)})
        self.assertEqual(depth, self.flat)
        self.assertEqual(segments, 0)

    def test_ranges_ending_inside_the_band_reduce_depth(self):
        # A position whose bounds sit inside +/-1%: lower bound at -50 (net +L), upper
        # bound at +50 (net -L). Liquidity falls away in both directions.
        depth, segments, _ = walk({-IN_BAND: 10 ** 17, IN_BAND: -(10 ** 17)})
        self.assertLess(depth, self.flat)
        self.assertEqual(segments, 2)

    def test_ranges_starting_inside_the_band_increase_depth(self):
        # The mirror image, and the reason the flat-L figure is NOT an upper bound:
        # liquidity that switches on inside the band makes real depth larger.
        depth, segments, _ = walk({-IN_BAND: -(10 ** 17), IN_BAND: 10 ** 17})
        self.assertGreater(depth, self.flat)
        self.assertEqual(segments, 2)

    def test_matches_brute_force_on_a_mixed_map(self):
        net = {-70: 10 ** 17, -30: -(10 ** 17), 20: 3 * 10 ** 17, 80: -(10 ** 17)}
        self.assertEqual(walk(net)[0], brute(net))

    def test_matches_brute_force_on_a_dense_map(self):
        net = {k: (10 ** 16 if k % 2 else -(10 ** 16)) for k in range(-95, 96, 5)}
        self.assertEqual(walk(net)[0], brute(net))

    def test_a_tick_at_the_current_price_is_crossed_not_skipped(self):
        # The regression. net[0] must be applied going down even though it opens no
        # segment; if it is skipped, every segment below runs on the wrong liquidity.
        net = {0: 5 * 10 ** 17, -40: 10 ** 17}
        self.assertEqual(walk(net)[0], brute(net))
        self.assertNotEqual(walk(net)[0], walk({-40: 10 ** 17})[0])

    def test_liquidity_going_negative_is_flagged_not_silently_clamped(self):
        # A corrupt map must surface as unusable rather than produce a plausible number.
        _, _, sane = walk({IN_BAND: -(10 ** 19)})
        self.assertFalse(sane)


if __name__ == "__main__":
    unittest.main(verbosity=2)
