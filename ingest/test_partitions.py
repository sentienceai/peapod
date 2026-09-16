"""Day partitioning: the boundaries, the append discipline, and the crash case."""

from __future__ import annotations

import datetime as dt

import numpy as np
import polars as pl
import pytest

from partitions import (BlockClock, day_key, days_in, partition_summary, read_days,
                        write_days)


def ts_at(y, m, d, hh=0, mm=0, ss=0):
    return int(dt.datetime(y, m, d, hh, mm, ss, tzinfo=dt.timezone.utc).timestamp())


def test_days_are_utc_and_include_both_ends():
    assert day_key(ts_at(2026, 9, 7, 0, 0, 0)) == "2026-09-07"
    assert day_key(ts_at(2026, 9, 7, 23, 59, 59)) == "2026-09-07"
    assert day_key(ts_at(2026, 9, 8, 0, 0, 0)) == "2026-09-08"
    # A window that starts mid-day must still read the day it started in.
    got = days_in(ts_at(2026, 9, 7, 13, 0), ts_at(2026, 9, 9, 2, 0))
    assert got == ["2026-09-07", "2026-09-08", "2026-09-09"]


def test_a_window_of_one_instant_still_reads_its_day():
    t = ts_at(2026, 9, 7, 13, 0)
    assert days_in(t, t) == ["2026-09-07"]


def frame(blocks):
    return pl.DataFrame({"block": blocks, "log_index": list(range(len(blocks))),
                         "v": [b * 2 for b in blocks]})


def test_writes_land_in_the_day_the_clock_says(tmp_path):
    df = frame([10, 20, 30])
    ts = np.array([ts_at(2026, 9, 7, 1), ts_at(2026, 9, 7, 23), ts_at(2026, 9, 8, 0)])
    written = write_days(df, tmp_path, ts)
    assert written == {"2026-09-07": 2, "2026-09-08": 1}
    assert {p.name for p in tmp_path.glob("dt=*")} == {"dt=2026-09-07", "dt=2026-09-08"}


def test_a_second_write_appends_and_never_rewrites(tmp_path):
    ts = np.array([ts_at(2026, 9, 7, 1)])
    write_days(frame([10]), tmp_path, ts)
    first = sorted((tmp_path / "dt=2026-09-07").glob("part-*.parquet"))
    before = first[0].read_bytes()
    write_days(frame([11]), tmp_path, ts)
    after = sorted((tmp_path / "dt=2026-09-07").glob("part-*.parquet"))
    assert len(after) == 2, "the second write did not append a new part"
    assert after[0].read_bytes() == before, "the first part was rewritten"
    assert read_days(tmp_path).height == 2


def test_reading_a_window_opens_its_days_plus_one_either_side(tmp_path):
    for day in (5, 6, 7, 8, 9, 10, 11):
        write_days(frame([day * 100]), tmp_path, np.array([ts_at(2026, 9, day, 12)]))
    got = read_days(tmp_path, ts_at(2026, 9, 8, 0), ts_at(2026, 9, 8, 23))
    # The 8th, plus the margin day either side. Not the 5th, 6th, 10th or 11th: the point
    # of partitioning is that a 7-day window does not open a year of files.
    assert sorted(got["block"].to_list()) == [700, 800, 900]
    exact = read_days(tmp_path, ts_at(2026, 9, 8, 0), ts_at(2026, 9, 8, 23), margin_days=0)
    assert sorted(exact["block"].to_list()) == [800]


def test_replaying_a_range_does_not_double_count(tmp_path):
    # An incremental cycle that is retried writes the same rows again. Identity is
    # (block, log_index), so the reader collapses them.
    ts = np.array([ts_at(2026, 9, 7, 1), ts_at(2026, 9, 7, 2)])
    write_days(frame([10, 11]), tmp_path, ts)
    write_days(frame([10, 11]), tmp_path, ts)
    assert read_days(tmp_path).height == 2


def test_a_part_truncated_by_a_crash_is_dropped_not_fatal(tmp_path):
    ts = np.array([ts_at(2026, 9, 7, 1)])
    write_days(frame([10]), tmp_path, ts)
    bad = tmp_path / "dt=2026-09-07" / "part-00001.parquet"
    bad.write_bytes(b"PAR1 truncated garbage")
    got = read_days(tmp_path)
    assert got.height == 1, "a short part file took the whole read down with it"


def test_the_writer_leaves_no_temporary_file_behind(tmp_path):
    write_days(frame([10]), tmp_path, np.array([ts_at(2026, 9, 7, 1)]))
    assert not list(tmp_path.rglob("*.tmp")), "a .tmp file is visible to the reader"


def test_measured_block_times_beat_interpolated_ones():
    # Interpolation is a straight line through a chain whose rate is not constant. Where
    # the chain has told us the answer, that answer wins.
    measured = pl.DataFrame({"block": [150], "ts": [1_000_500]})
    fallback = pl.DataFrame({"block": [100, 200], "ts": [1_000_000, 1_002_000]})
    clock = BlockClock(measured, fallback)
    assert clock.ts_of(np.array([150]))[0] == 1_000_500
    assert bool(clock.is_measured(np.array([150]))[0])
    assert not bool(clock.is_measured(np.array([100]))[0])


def test_the_clock_refuses_to_be_built_from_nothing():
    with pytest.raises(ValueError):
        BlockClock(None, None)


def test_summary_reports_what_is_actually_on_disk(tmp_path):
    for day in (7, 8):
        write_days(frame([day]), tmp_path, np.array([ts_at(2026, 9, day, 1)]))
    s = partition_summary(tmp_path)
    assert s["days"] == 2 and s["rows"] == 2
    assert s["first"] == "2026-09-07" and s["last"] == "2026-09-08"


def test_a_row_filed_on_the_wrong_side_of_midnight_is_still_read(tmp_path):
    # Interpolation puts this row in the 8th; it really happened at 23:59:10 on the 7th.
    write_days(frame([10]), tmp_path, np.array([ts_at(2026, 9, 8, 0, 0, 30)]))
    got = read_days(tmp_path, ts_at(2026, 9, 7, 0), ts_at(2026, 9, 7, 23, 59, 59))
    assert got.height == 1, "the margin did not save a row misplaced across midnight"


def test_the_margin_can_be_turned_off_when_times_are_exact(tmp_path):
    write_days(frame([10]), tmp_path, np.array([ts_at(2026, 9, 8, 0, 0, 30)]))
    got = read_days(tmp_path, ts_at(2026, 9, 7, 0), ts_at(2026, 9, 7, 23, 59, 59),
                    margin_days=0)
    assert got.height == 0


def test_measured_and_vendored_block_times_combine(tmp_path, monkeypatch):
    # The vendored table carries UInt64 from upstream; times this repository measures are
    # written as Int64. A clock that had recorded anything would not load, which is every
    # container after its first identity stage.
    measured = pl.DataFrame({"block": pl.Series([150], dtype=pl.Int64),
                             "ts": pl.Series([1_000_500], dtype=pl.Int64)})
    vendored = pl.DataFrame({"block": pl.Series([100, 200], dtype=pl.UInt64),
                             "ts": pl.Series([1_000_000, 1_002_000], dtype=pl.UInt64)})
    clock = BlockClock(measured, vendored)
    assert clock.ts_of(np.array([150]))[0] == 1_000_500
    assert clock.ts_of(np.array([100]))[0] == 1_000_000
