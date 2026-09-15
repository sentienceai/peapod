"""Gates on the calculator precompute.

Two things have to be true for windows.json to mean anything:

  1. The faster tick splitter is the SAME MODEL as fee_attribution.split_swap_at_ticks.
     peapod named that as its single fee model, so the only licence taken here is a bisect
     in place of a full scan of the tick map. These tests assert segment-for-segment
     identity against lp-terminal's own function on randomised maps and swaps.

  2. The bucketed fee kernel reproduces the unbucketed sum. The browser never sees the
     tape, only the buckets, so if the bucketing is lossy the calculator is wrong by
     however much it loses.
"""

from __future__ import annotations

import random
import sys
import unittest

import numpy as np

import windows as W
from upstream import engine, lp_terminal

lm, ROOT, _ = engine()
sys.path.insert(0, str(ROOT / "engine"))
import fee_attribution as FA  # noqa: E402


def random_map(rng, spacing=60, count=40):
    net = {}
    for _ in range(count):
        lo = rng.randrange(-20, 20) * spacing
        hi = lo + rng.randrange(1, 10) * spacing
        delta = rng.randrange(1, 10 ** 15)
        net[lo] = net.get(lo, 0) + delta
        net[hi] = net.get(hi, 0) - delta
    return {t: v for t, v in net.items() if v != 0}


class Splitter(unittest.TestCase):
    def test_identical_to_lp_terminal_split(self):
        rng = random.Random(20260914)
        compared = 0
        for _ in range(400):
            net = random_map(rng)
            ticks_sorted = sorted(net)
            start = rng.randrange(-1200, 1200)
            end = rng.randrange(-1200, 1200)
            if start == end:
                continue
            sqrt_start = lm.get_sqrt_price_at_tick(start)
            sqrt_end = lm.get_sqrt_price_at_tick(end)
            liquidity = rng.randrange(1, 10 ** 18)

            theirs = FA.split_swap_at_ticks(start, sqrt_start, end, sqrt_end, net, liquidity)
            mine = W.split_swap(lm, start, sqrt_start, end, sqrt_end, ticks_sorted, net, liquidity)

            self.assertEqual(len(mine), len(theirs))
            for got, want in zip(mine, theirs):
                # theirs is (tick_lo, tick_hi, sqrt_lo, sqrt_hi, activeL)
                self.assertEqual(got, (want[2], want[3], want[4]))
            compared += 1
        self.assertGreater(compared, 300, "the randomised comparison barely ran")

    def test_identical_on_an_empty_map(self):
        sqrt_a = lm.get_sqrt_price_at_tick(0)
        sqrt_b = lm.get_sqrt_price_at_tick(500)
        theirs = FA.split_swap_at_ticks(0, sqrt_a, 500, sqrt_b, {}, 10 ** 18)
        mine = W.split_swap(lm, 0, sqrt_a, 500, sqrt_b, [], {}, 10 ** 18)
        self.assertEqual(len(mine), 1)
        self.assertEqual(mine[0], (theirs[0][2], theirs[0][3], theirs[0][4]))


class FeeKernel(unittest.TestCase):
    def _sample(self, seed, n=4000, spread=6):
        rng = np.random.default_rng(seed)
        return 10 ** rng.uniform(15, 15 + spread, n), rng.gamma(2.0, 3.0, n)

    def test_certified_error_is_honest(self):
        # The bound the kernel ships must actually hold at the sizes it claims to cover.
        for spread in (0.5, 2, 4, 6):
            active, fee = self._sample(11, spread=spread)
            for k in (1e9, 1e12, 1e15, 1e18):
                totals, reps, _, certified = W.fee_kernel(active, fee, k)
                for size in W.SIZE_GRID:
                    L = k * size
                    want = W.exact_fees(active, fee, L)
                    if want <= 0:
                        continue
                    got = W.evaluate_kernel(totals, reps, L)
                    self.assertLessEqual(
                        abs(got - want) / want, certified * 1.000001,
                        f"certified {certified:.2e} understates the error at ${size:,.0f}")

    def test_target_is_met_on_realistic_books(self):
        for spread in (0.5, 1, 2, 3):
            active, fee = self._sample(12, spread=spread)
            *_, certified = W.fee_kernel(active, fee, 1e12)
            self.assertLessEqual(certified, W.TARGET_REL_ERROR)

    def test_exact_in_both_limits(self):
        active, fee = self._sample(13)
        totals, reps, total, _ = W.fee_kernel(active, fee, 1e12)
        self.assertAlmostEqual(sum(totals), total, places=6)
        tiny = 1.0
        self.assertAlmostEqual(
            W.evaluate_kernel(totals, reps, tiny) / W.exact_fees(active, fee, tiny), 1.0, places=6)
        self.assertAlmostEqual(W.evaluate_kernel(totals, reps, 1e40), total, places=3)

    def test_simple_books_stay_small(self):
        # A pool whose book barely moves must not ship dozens of buckets.
        rng = np.random.default_rng(14)
        active = np.full(2000, 5e16) * rng.uniform(0.98, 1.02, 2000)
        fee = rng.gamma(2.0, 3.0, 2000)
        totals, _, _, certified = W.fee_kernel(active, fee, 1e12)
        self.assertLessEqual(len(totals), 4, f"{len(totals)} buckets for a flat book")
        self.assertLessEqual(certified, W.TARGET_REL_ERROR)

    def test_kernel_is_monotone_in_size(self):
        active, fee = self._sample(15)
        totals, reps, _, _ = W.fee_kernel(active, fee, 1e12)
        values = [W.evaluate_kernel(totals, reps, 1e12 * s) for s in W.SIZE_GRID]
        self.assertEqual(values, sorted(values))

    def test_empty_input_is_zero_not_an_error(self):
        self.assertEqual(W.fee_kernel(np.array([]), np.array([]), 1e12), ([], [], 0.0, 0.0))
        self.assertEqual(W.evaluate_kernel([], [], 1e18), 0.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
