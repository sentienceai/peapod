"""Day partitioning: the boundaries, the append discipline, and the crash case."""

from __future__ import annotations

import datetime as dt

import numpy as np
import polars as pl
import pytest

from partitions import (BlockClock, compact, day_key, days_in, migrate, partition_summary,
                        read_days, write_days)


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


# ── the cursor, and the repair for the tree that was written without one ─────────────────
#
# THE BUG THESE PIN. migrate() was written as a one-off and then wired into the cycle,
# where it re-partitioned the whole flat tape every fifteen minutes. write_days() never
# rewrites an existing part, so each run appended a complete fresh copy of every day it
# touched: 162 copies of each day, 43 GB of duplicate parquet on a 48.8 GB volume, from
# flat tapes totalling 333 MB. Nothing was WRONG — read_days() dedups on (block,
# log_index) — which is precisely why it ran for two days without anyone noticing.

def flat(tmp_path, rows, part="part-00000.parquet"):
    """A flat source tape, the shape the ingest writes."""
    src = tmp_path / "src"
    src.mkdir(parents=True, exist_ok=True)
    pl.DataFrame(rows, schema={"block": pl.Int64, "log_index": pl.Int64},
                 orient="row").write_parquet(src / part)
    return src


def clock_for(blocks):
    return BlockClock(pl.DataFrame({"block": [b for b, _ in blocks],
                                    "ts": [t for _, t in blocks]},
                                   schema={"block": pl.Int64, "ts": pl.Int64}))


def test_a_second_migrate_of_the_same_tape_writes_nothing(tmp_path):
    src = flat(tmp_path, [(100, 0), (100, 1)])
    dst = tmp_path / "days"
    clock = clock_for([(100, 1_700_000_000)])
    first = migrate(src, dst, clock)
    assert first["written"] == 2 and first["new_parts"] == 1
    again = migrate(src, dst, clock)
    assert again["written"] == 0, "the whole tape was partitioned a second time"
    assert again["new_parts"] == 0 and again["skipped_parts"] == 1
    files = list((dst / "dt=2023-11-14").glob("part-*.parquet"))
    assert len(files) == 1, f"{len(files)} copies of one day after two runs"


def test_a_new_source_part_is_partitioned_and_the_old_ones_are_not(tmp_path):
    src = flat(tmp_path, [(100, 0)])
    dst = tmp_path / "days"
    clock = clock_for([(100, 1_700_000_000), (200, 1_700_000_000)])
    migrate(src, dst, clock)
    pl.DataFrame([(200, 0)], schema={"block": pl.Int64, "log_index": pl.Int64},
                 orient="row").write_parquet(src / "part-00001.parquet")
    second = migrate(src, dst, clock)
    assert second["new_parts"] == 1 and second["source_rows"] == 1
    got = read_days(dst, dedup_on=("block", "log_index"))
    assert sorted(got["block"].to_list()) == [100, 200]


def test_a_source_part_that_grew_is_read_again_and_the_reader_dedups(tmp_path):
    # The ingest rewrites the part it is currently filling, so a changed size means new
    # rows in a file already seen. Re-reading it is cheap and correct; the alternative is
    # losing whatever arrived after the last cycle.
    src = flat(tmp_path, [(100, 0)])
    dst = tmp_path / "days"
    clock = clock_for([(100, 1_700_000_000)])
    migrate(src, dst, clock)
    pl.DataFrame([(100, 0), (100, 1)], schema={"block": pl.Int64, "log_index": pl.Int64},
                 orient="row").write_parquet(src / "part-00000.parquet")
    again = migrate(src, dst, clock)
    assert again["new_parts"] == 1
    got = read_days(dst, dedup_on=("block", "log_index"))
    assert got.height == 2, "the overlapping row was counted twice"


def test_a_cold_tree_still_partitions_everything(tmp_path):
    src = flat(tmp_path, [(100, 0), (100, 1)])
    report = migrate(src, tmp_path / "days", clock_for([(100, 1_700_000_000)]))
    assert report["written"] == 2 and report["skipped_parts"] == 0


def test_compaction_merges_a_day_and_keeps_every_row(tmp_path):
    dst = tmp_path / "days"
    clock = clock_for([(100, 1_700_000_000), (200, 1_700_000_001)])
    # Three cycles of the old behaviour: the same rows, three times over.
    for i in range(3):
        src = flat(tmp_path / f"s{i}", [(100, 0), (200, 0)])
        migrate(src, dst, clock, incremental=False)
    day = dst / "dt=2023-11-14"
    assert len(list(day.glob("part-*.parquet"))) == 3
    before = read_days(dst, dedup_on=("block", "log_index"))
    report = compact(dst)
    assert report["parts_before"] == 3 and report["parts_after"] == 1
    assert report["bytes_after"] < report["bytes_before"]
    assert len(list(day.glob("part-*.parquet"))) == 1
    after = read_days(dst, dedup_on=("block", "log_index"))
    assert sorted(after["block"].to_list()) == sorted(before["block"].to_list())
    assert not list(day.glob("*.tmp")), "compaction left a temporary file behind"


def test_a_part_that_grew_contributes_only_its_new_rows(tmp_path):
    """The ingest appends to the part it is filling, so that file comes back every cycle.

    Copying all of it again is invisible — the reader dedups — and it is exactly how 43 GB
    of duplicates accumulated. Parts are append-only in row order, so what is new is the
    tail, and only the tail is written.
    """
    src = flat(tmp_path, [(100, 0)])
    dst = tmp_path / "days"
    clock = clock_for([(100, 1_700_000_000)])
    migrate(src, dst, clock)
    pl.DataFrame([(100, 0), (100, 1), (100, 2)],
                 schema={"block": pl.Int64, "log_index": pl.Int64},
                 orient="row").write_parquet(src / "part-00000.parquet")
    second = migrate(src, dst, clock)
    assert second["source_rows"] == 2, "the rows already partitioned were copied again"
    got = read_days(dst, dedup_on=("block", "log_index"))
    assert got.height == 3


def test_compaction_never_holds_more_than_one_part_beyond_the_result(tmp_path, monkeypatch):
    """The day this repairs is 1.9 GB across 162 copies of itself.

    Reading them all into one frame to dedup wants several gigabytes for a 12 MB answer,
    and the container gets killed instead of repaired. So the parts are folded one at a
    time into a running deduped frame: peak memory is one deduped day plus one part, and
    this counts the reads to prove the loop is incremental rather than a gather.
    """
    dst = tmp_path / "days"
    clock = clock_for([(100, 1_700_000_000), (200, 1_700_000_001)])
    for i in range(5):
        src = flat(tmp_path / f"s{i}", [(100, 0), (200, 0)])
        migrate(src, dst, clock, incremental=False)

    live = []
    real = pl.read_parquet

    def counting(path, *a, **kw):
        frame = real(path, *a, **kw)
        live.append(frame.height)
        return frame

    monkeypatch.setattr(pl, "read_parquet", counting)
    report = compact(dst)
    monkeypatch.undo()
    assert report["parts_after"] == 1
    # Five reads of two rows each, never one read of ten.
    assert live == [2, 2, 2, 2, 2], live
    assert read_days(dst, dedup_on=("block", "log_index")).height == 2
