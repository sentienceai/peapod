"""The gates, exercised against builds that are wrong.

A gate that has only ever been seen passing is decoration. Each of these constructs the
fault the gate exists to catch and asserts the build would be rejected.
"""

from __future__ import annotations

import polars as pl
import pytest

from gates import Gates, run, summarise

BEFORE = {"addresses": 100_000, "qualifying": 30_000, "build": "20260101T000000Z",
          "to_ts": 1_000_000, "top_realized": 188_638.0, "scopes": 14}
STATS = {"to_ts": 1_100_000, "qualifying": 30_100, "top_realized": 190_000.0,
         "addresses": 101_000, "scopes": 14}
VIEWS = [{"scope": "all", "window": "7d", "rows": 1000},
         {"scope": "rwa", "window": "7d", "rows": 1000}]
ETH = {"points": 72_236, "spread_pct": 8.8, "max_gap_s": 285}


def clean_trades():
    return pl.DataFrame({"tx": ["a", "b", "c"], "book": ["X", "Y", "Z"]})


def go(**over):
    kw = {"before": BEFORE, "stats": dict(STATS), "trades": clean_trades(),
          "views": list(VIEWS), "missing_ranked": 0, "address_count": 101_000,
          "eth": dict(ETH), "gaps": []}
    kw.update(over)
    return run(Gates(), **kw)


def test_a_healthy_build_passes_every_gate():
    g = go()
    assert not g.failed and not g.warned, g.report()
    assert "0 failed" in summarise(g)


def test_a_tape_that_went_backwards_is_rejected():
    # A cursor reset or a stale partition read: the ranking would be of last week.
    g = go(stats={**STATS, "to_ts": 900_000})
    assert [r.name for r in g.failed] == ["window advances"]


def test_addresses_vanishing_is_rejected():
    # The store upserts and never deletes, so a fall means rows were lost.
    g = go(address_count=90_000)
    assert "address count does not fall" in [r.name for r in g.failed]


def test_a_duplicated_position_change_is_rejected():
    # One event counted twice inflates every volume and PnL figure downstream.
    dup = pl.DataFrame({"tx": ["a", "a", "b"], "book": ["X", "X", "Y"]})
    g = go(trades=dup)
    assert "no duplicated position changes" in [r.name for r in g.failed]


def test_a_resolver_that_returned_nobody_is_rejected():
    g = go(stats={**STATS, "qualifying": 400})
    assert "qualifying count is in band" in [r.name for r in g.failed]


def test_a_fold_that_matched_everything_is_rejected():
    g = go(stats={**STATS, "qualifying": 90_000})
    assert "qualifying count is in band" in [r.name for r in g.failed]


def test_a_ranked_address_with_no_detail_is_rejected():
    # The one failure a visitor is guaranteed to hit: click the top row, get a 404.
    g = go(missing_ranked=3)
    assert "every ranked address has a detail record" in [r.name for r in g.failed]


def test_an_empty_view_is_rejected():
    g = go(views=[{"scope": "all", "window": "7d", "rows": 1000},
                  {"scope": "pons", "window": "7d", "rows": 0}])
    assert "every declared view has rows" in [r.name for r in g.failed]


def test_nan_in_the_summary_is_rejected():
    # NaN is not JSON: the page would fail at parse time, which is a blank screen.
    g = go(stats={**STATS, "top_realized": float("nan")})
    assert "no NaN or Infinity in the summary" in [r.name for r in g.failed]
    g2 = go(stats={**STATS, "top_realized": float("inf")})
    assert "no NaN or Infinity in the summary" in [r.name for r in g2.failed]


def test_a_flat_or_missing_price_series_is_rejected():
    # Every ETH-quoted trade is denominated through it; a flat series silently rewrites
    # half the table rather than erroring.
    assert "eth series is present and moving" in [r.name for r in go(
        eth={**ETH, "spread_pct": 0.0}).failed]
    assert "eth series is present and moving" in [r.name for r in go(
        eth={**ETH, "points": 12}).failed]


def test_a_long_hole_in_the_series_warns_but_does_not_block():
    # Unusual is not broken. A gate that cannot tell them apart should not take the site
    # down, so this one records and commits.
    g = go(eth={**ETH, "max_gap_s": 7200})
    assert not g.failed
    assert "eth series has no long hole" in [r.name for r in g.warned]


def test_a_hundredfold_jump_in_the_top_figure_warns():
    # A decimals or units fault looks exactly like this, but so does one real whale, so
    # it is reported rather than blocking.
    g = go(stats={**STATS, "top_realized": 18_000_000.0})
    assert not g.failed
    assert "top result is in band" in [r.name for r in g.warned]


def test_the_first_build_skips_the_comparisons_it_cannot_make():
    g = go(before={"addresses": 0, "qualifying": 0, "build": None, "to_ts": None,
                   "top_realized": None, "scopes": 0})
    assert not g.failed
    names = [r.name for r in g.results]
    assert "qualifying count is in band" not in names
    assert "window advances" not in names


def test_several_faults_are_all_reported_not_just_the_first():
    # A cycle that is wrong in three ways should say so once, not three runs later.
    g = go(address_count=1, missing_ranked=5, stats={**STATS, "qualifying": 10})
    assert len(g.failed) == 3, g.report()


@pytest.mark.parametrize("ratio", [0.51, 1.0, 1.99])
def test_the_band_is_wide_enough_for_an_ordinary_day(ratio):
    # A band tight enough to catch a quiet Sunday will block a real build at 3am, and a
    # gate that fires on normal days gets disabled.
    g = go(stats={**STATS, "qualifying": int(30_000 * ratio)})
    assert not g.failed, g.report()


def test_an_unreadable_range_blocks_the_build():
    # The ingest used to print "skipping ahead" and move on, so the only record of a hole
    # was a log line nobody reads and a tape that looked complete. Everything downstream
    # is arithmetic on rows that are not there, and all of it looks healthy.
    g = go(gaps=[{"from": 60_482_370, "to": 60_482_569, "blocks": 200,
                  "why": "unreadable: exceed max topics"}])
    failed = [r.name for r in g.failed]
    assert "no unreadable ranges in the tape" in failed
    detail = next(r.detail for r in g.results if r.name == "no unreadable ranges in the tape")
    assert "200 blocks" in detail and "60,482,370" in detail


def test_several_gaps_are_summed_not_just_counted():
    g = go(gaps=[{"from": 1, "to": 200, "blocks": 200, "why": "a"},
                 {"from": 900, "to": 1299, "blocks": 400, "why": "b"}])
    detail = next(r.detail for r in g.results if r.name == "no unreadable ranges in the tape")
    assert "2 gap(s) covering 600 blocks" in detail


def test_no_gaps_is_the_normal_case():
    assert not go(gaps=[]).failed
    assert not go().failed
