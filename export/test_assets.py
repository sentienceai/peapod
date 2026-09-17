"""The asset aggregation, exercised on tapes small enough to check by hand.

Every figure here is one a reader of the site would act on — a price, a 24-hour move, who
traded last — so each test states the tape and the number it must produce. The cases that
matter are the ones where there is no honest answer: no trade a day old, nothing but dust.
Those must come out None, and stay None.
"""

from __future__ import annotations

import polars as pl

from build_leaderboard import ASSET_TRADES, addressable, assets

SCHEMA = {"addr": pl.String, "label": pl.String, "cat": pl.String, "qty": pl.Float64,
          "usd": pl.Float64, "ts": pl.Int64, "quote": pl.String}
HOUR = 3600
DAY = 86400
NOW = 1_700_000_000


def tape(rows) -> pl.DataFrame:
    """(addr, label, cat, qty, usd, ts) -> the frame the fold reads. Quote is USDG unless
    a test is about it; nothing here depends on it."""
    return pl.DataFrame([(*r, "USDG") for r in rows], schema=SCHEMA, orient="row")


def one(rows, to_ts=NOW) -> dict:
    out = assets(tape(rows), to_ts)
    assert len(out) == 1, [a["asset"]["symbol"] for a in out]
    return out[0]


def test_price_is_the_most_recent_trade_not_the_largest():
    # A whale earlier in the window must not set the headline price.
    a = one([("0xa", "TSLA", "rwa", 1000.0, -400_000.0, NOW - 7200),
             ("0xb", "TSLA", "rwa", -2.0, 900.0, NOW - 60)])["asset"]
    assert a["price"] == 450.0
    assert a["symbol"] == "TSLA" and a["kind"] == "stock"


def test_change24h_is_none_when_the_window_holds_no_trade_that_old():
    # Not zero. Zero means it did not move, which is a measurement nobody made here.
    a = one([("0xa", "TSLA", "rwa", 1.0, -100.0, NOW - HOUR),
             ("0xb", "TSLA", "rwa", -1.0, 110.0, NOW - 60)])["asset"]
    assert a["change24h"] is None


def test_change24h_measures_from_the_last_trade_at_or_before_the_boundary():
    a = one([("0xa", "TSLA", "rwa", 1.0, -50.0, NOW - DAY - 2 * HOUR),
             ("0xb", "TSLA", "rwa", 1.0, -100.0, NOW - DAY),          # the reference
             ("0xc", "TSLA", "rwa", -1.0, 125.0, NOW - 60)])["asset"]
    assert a["change24h"] == 25.0
    assert a["price"] == 125.0


def test_volume24h_excludes_older_trades_and_volume_covers_the_window():
    a = one([("0xa", "TSLA", "rwa", 1.0, -1000.0, NOW - 2 * DAY),
             ("0xb", "TSLA", "rwa", 1.0, -30.0, NOW - DAY - 1),
             ("0xc", "TSLA", "rwa", -1.0, 20.0, NOW - HOUR)])["asset"]
    assert a["volume24h"] == 20.0
    assert a["volume"] == 1050.0


def test_traders_counts_distinct_addresses_and_trades_counts_rows():
    a = one([("0xa", "TSLA", "rwa", 1.0, -10.0, NOW - 300),
             ("0xa", "TSLA", "rwa", -1.0, 11.0, NOW - 200),
             ("0xb", "TSLA", "rwa", 1.0, -12.0, NOW - 100)])["asset"]
    assert a["traders"] == 2
    assert a["trades"] == 3


def test_a_dust_row_does_not_set_the_price():
    # abs(usd)/abs(qty) on a dust quantity is a price of billions, and it would arrive as
    # this asset's headline number. The row is still volume: it happened.
    a = one([("0xa", "TSLA", "rwa", 2.0, -800.0, NOW - 600),
             ("0xb", "TSLA", "rwa", 1e-18, -5.0, NOW - 10)])
    assert a["asset"]["price"] == 400.0
    assert a["asset"]["volume"] == 805.0
    assert a["asset"]["trades"] == 2
    assert [t["ts"] for t in a["trades"]] == [NOW - 600]


def test_an_asset_of_nothing_but_dust_has_no_price_rather_than_a_wrong_one():
    a = one([("0xa", "TSLA", "rwa", 1e-18, -5.0, NOW - 10)])["asset"]
    assert a["price"] is None and a["change24h"] is None


def test_the_trade_list_is_the_most_recent_fifty_newest_first():
    rows = [("0xa", "PONS", "pons", 1.0, -float(i + 1), NOW - (200 - i)) for i in range(200)]
    a = one(rows)
    assert len(a["trades"]) == ASSET_TRADES
    ts = [t["ts"] for t in a["trades"]]
    assert ts == sorted(ts, reverse=True)
    assert ts[0] == NOW - 1
    assert a["trades"][0]["value"] == 200.0
    assert a["asset"]["trades"] == 200


def test_a_trade_carries_an_absolute_quantity_and_the_side_of_the_signed_one():
    a = one([("0xbuyer", "PONS", "pons", 4.0, -20.0, NOW - 200),
             ("0xseller", "PONS", "pons", -4.0, 24.0, NOW - 100)])
    sell, buy = a["trades"]
    assert sell["side"] == "sell" and sell["address"] == "0xseller"
    assert sell["qty"] == 4.0 and sell["value"] == 24.0 and sell["price"] == 6.0
    assert buy["side"] == "buy" and buy["qty"] == 4.0 and buy["value"] == 20.0


def test_the_series_is_one_point_an_hour_and_the_point_is_the_last_trade_in_it():
    rows = [("0xa", "TSLA", "rwa", 1.0, -10.0, NOW - 2 * HOUR),
            ("0xa", "TSLA", "rwa", 1.0, -11.0, NOW - 2 * HOUR + 5),
            ("0xa", "TSLA", "rwa", 1.0, -12.0, NOW - 60)]
    series = one(rows)["series"]
    assert [p[1] for p in series] == [11.0, 12.0]
    assert [p[0] for p in series] == [NOW - 2 * HOUR + 5, NOW - 60]


def test_the_series_is_capped_and_keeps_its_endpoints():
    rows = [("0xa", "TSLA", "rwa", 1.0, -float(i + 1), NOW - (400 - i) * HOUR)
            for i in range(400)]
    series = one(rows)["series"]
    assert len(series) == 200
    assert series[0][1] == 1.0 and series[-1][1] == 400.0


def test_pons_is_a_meme_and_rwa_is_a_stock():
    kinds = {a["asset"]["symbol"]: a["asset"]["kind"] for a in assets(tape([
        ("0xa", "TSLA", "rwa", 1.0, -10.0, NOW - 60),
        ("0xa", "DOGGO", "pons", 1.0, -10.0, NOW - 60)]), NOW)}
    assert kinds == {"TSLA": "stock", "DOGGO": "meme"}


def test_a_symbol_in_emoji_or_chinese_is_shipped_like_any_other():
    # Three Pons tokens on this tape are named in emoji or Chinese. The alphabet used to be
    # [A-Za-z0-9.] and dropped all three — while the LEADERBOARD went on listing them in its
    # own rows, so the asset list and the board disagreed about which tokens exist. A symbol
    # is data from the chain, not a name we choose; the URL carries it percent-encoded.
    out = assets(tape([("0xa", "\U0001F17F\uFE0F", "pons", 1.0, -10.0, NOW - 60),
                       ("0xb", "\u7F57\u5BBE\u4FA0", "pons", 1.0, -20.0, NOW - 60),
                       ("0xc", "TSLA", "rwa", 1.0, -30.0, NOW - 60)]), NOW)
    assert sorted(a["asset"]["symbol"] for a in out) == sorted(
        ["\U0001F17F\uFE0F", "\u7F57\u5BBE\u4FA0", "TSLA"])


def test_a_symbol_no_url_could_carry_is_still_refused():
    # What the widened rule still refuses, and why: a path separator would make the symbol a
    # path, the two dot names are reserved, and a control character is invisible in a log.
    for bad in ["a/b", "a\\b", ".", "..", "x" * 33, "null\x00byte"]:
        assert not addressable(bad), bad
    for good in ["TSLA", "BRK.B", "\U0001F17F\uFE0F", "\u7F57\u5BBE\u4FA0"]:
        assert addressable(good), good


def test_assets_come_back_richest_first():
    out = assets(tape([("0xa", "SMALL", "pons", 1.0, -10.0, NOW - 60),
                       ("0xb", "BIG", "rwa", 1.0, -1000.0, NOW - 60)]), NOW)
    assert [a["asset"]["symbol"] for a in out] == ["BIG", "SMALL"]


def test_every_number_survives_the_json_boundary():
    # The store packs these with allow_nan=False, so a NaN or an Infinity anywhere in here
    # aborts a cycle that had already passed its gates.
    import json  # noqa: PLC0415
    rows = [("0xa", "TSLA", "rwa", 1.0, -10.0, NOW - DAY - 1),
            ("0xb", "TSLA", "rwa", -1.0, 0.0, NOW - 30)]
    json.dumps(assets(tape(rows), NOW), allow_nan=False)
