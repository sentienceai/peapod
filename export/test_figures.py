"""The realized drawdown, computed over every close.

It is the one figure on the profile that cannot be taken from the shipped series: that is
downsampled to 500 points, and a sample can step over the trough. So it is computed in the
build, where the whole curve exists, and these are the cases that pin it.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_leaderboard import downsample, max_drawdown


def test_a_curve_that_only_rises_has_no_drawdown():
    assert max_drawdown([(1, 5.0), (2, 9.0)])["depth"] == 0


def test_the_deepest_fall_wins_not_the_first():
    dd = max_drawdown([(1, 10.0), (2, 4.0), (3, 12.0), (4, 1.0)])
    assert dd["depth"] == 11
    assert (dd["from_ts"], dd["to_ts"]) == (3, 4)


def test_a_curve_that_never_rose_is_in_drawdown_from_zero():
    # The curve starts at zero. Reporting nothing here would flatter an address that only
    # ever lost money.
    assert max_drawdown([(1, -3.0), (2, -9.0)])["depth"] == 9


def test_an_empty_curve_is_zero_not_an_error():
    assert max_drawdown([])["depth"] == 0
    assert max_drawdown([])["closes"] == 0


def test_the_figure_counts_every_close():
    series = [(i, float(i)) for i in range(1200)]
    assert max_drawdown(series)["closes"] == 1200


def test_the_sampled_series_can_miss_the_trough_which_is_why_this_exists():
    # A spike down between two sample points. The build computes over the full curve; the
    # downsampled one the chart draws is a lower bound, and the interface says so when it
    # has to fall back to it.
    series = [(i, 100.0) for i in range(1200)]
    series[601] = (601, 0.0)
    full = max_drawdown(series)["depth"]
    sampled = max_drawdown(downsample([[t, v] for t, v in series]))["depth"]
    assert full == 100
    assert sampled < full
