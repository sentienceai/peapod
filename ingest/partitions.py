"""Day-partitioned parquet, and the clock that decides which day a block belongs to.

WHY PARTITION AT ALL. Every window query -- the 1-day and 7-day leaderboards, the ETH/USD
series, the daily breakdown -- asks for "the last N days". Against flat part-NNNNN files
that is a full scan of the tape, which is 24 files today and thousands by year end. Against
dt=YYYY-MM-DD it is eight directories, and an incremental cycle appends to exactly one.

THE CLOCK IS THE HARD PART. `blockTimestamp` comes back as 0x0 on every log from the public
endpoint, so a swap log cannot say what day it happened. But the identity resolver already
fetches whole blocks to read tx.from, and a whole block carries its timestamp -- it was
being decoded and thrown away. Recording it gives an EXACT block -> time map for every
block we resolve, owned by this repository, instead of interpolating against a table that
lives in another one.

Interpolation is still used for blocks resolved before this existed, and it is not exact:
between two samples it is a straight line through a chain whose block rate is not constant.
That is fine for a 7-day bucket and wrong at a day boundary, so `day_of` reports whether
each timestamp was measured or interpolated, and the migration records how many of each it
used rather than presenting one number as if it were the other.

APPEND, NEVER REWRITE. A cycle writes a new part file inside the day's directory and never
touches an existing one, so a crash mid-write leaves a short file that the reader drops
rather than a corrupted day. Readers dedup on (block, log_index), which is the identity
ingest/dedup.py already enforces, so replaying a range that was partly written is safe.
"""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import numpy as np
import polars as pl

HERE = Path(__file__).resolve().parent
CLOCK = HERE / "out" / "block_times"
DAY = 86400


def day_key(ts: int) -> str:
    """The UTC day a timestamp falls in. UTC because a leaderboard window is not local."""
    return dt.datetime.fromtimestamp(int(ts), dt.timezone.utc).strftime("%Y-%m-%d")


def days_in(from_ts: int, to_ts: int) -> list[str]:
    """Every UTC day touched by a window, inclusive of both ends."""
    start = int(from_ts) - int(from_ts) % DAY
    return [day_key(t) for t in range(start, int(to_ts) + 1, DAY)]


class BlockClock:
    """block -> unix seconds, exact where measured and interpolated where not."""

    def __init__(self, measured: pl.DataFrame | None = None,
                 fallback: pl.DataFrame | None = None):
        frames = [f for f in (measured, fallback) if f is not None and f.height]
        if not frames:
            raise ValueError("BlockClock needs at least one source of block times")
        # Measured wins on collision: it is the chain's own answer, not a line through it.
        self.measured_blocks = (measured["block"].to_numpy().astype(np.int64)
                                if measured is not None and measured.height
                                else np.array([], dtype=np.int64))
        # Cast before concatenating. The vendored block_times carries UInt64 from
        # upstream and the times this repository measures are Int64, so a clock that had
        # recorded anything would not load — which is every container after its first
        # identity stage.
        allc = pl.concat([f.select(pl.col("block").cast(pl.Int64),
                                   pl.col("ts").cast(pl.Int64)) for f in frames]).unique(
            subset=["block"], keep="first").sort("block")
        self.blocks = allc["block"].to_numpy().astype(np.int64)
        self.times = allc["ts"].to_numpy().astype(np.int64)

    @classmethod
    def load(cls, fallback_root: Path | None = None) -> "BlockClock":
        measured = None
        if CLOCK.exists():
            parts = sorted(CLOCK.glob("part-*.parquet"))
            if parts:
                measured = pl.concat([pl.read_parquet(p) for p in parts]).unique(
                    subset=["block"])
        fallback = None
        try:
            import sys as _s  # noqa: PLC0415
            _s.path.insert(0, str(HERE.parent / "export"))
            from registry import block_times  # noqa: PLC0415
            fallback = block_times().select("block", "ts")
        except Exception:  # noqa: BLE001
            pass
        return cls(measured, fallback)

    def ts_of(self, blocks: np.ndarray) -> np.ndarray:
        b = np.asarray(blocks, dtype=np.int64)
        return np.interp(b, self.blocks, self.times).astype(np.int64)

    def is_measured(self, blocks: np.ndarray) -> np.ndarray:
        """Which of these blocks the chain told us about directly."""
        if not len(self.measured_blocks):
            return np.zeros(len(blocks), dtype=bool)
        return np.isin(np.asarray(blocks, dtype=np.int64), self.measured_blocks)


def record_block_times(rows: list[tuple[int, int]]) -> int:
    """Persist (block, ts) pairs seen while resolving. Append-only, deduped on read."""
    if not rows:
        return 0
    CLOCK.mkdir(parents=True, exist_ok=True)
    n = len(list(CLOCK.glob("part-*.parquet")))
    pl.DataFrame({"block": [int(b) for b, _ in rows], "ts": [int(t) for _, t in rows]}) \
        .unique(subset=["block"]).write_parquet(CLOCK / f"part-{n:05d}.parquet")
    return len(rows)


def write_days(df: pl.DataFrame, root: Path, ts: np.ndarray) -> dict[str, int]:
    """Append rows into dt=YYYY-MM-DD/, one new part file per day touched.

    Never rewrites an existing part. A crash leaves a short file, which the reader drops,
    rather than a half-overwritten day.
    """
    root.mkdir(parents=True, exist_ok=True)
    keys = np.array([day_key(t) for t in ts])
    written: dict[str, int] = {}
    for day in sorted(set(keys.tolist())):
        chunk = df.filter(pl.Series(keys == day))
        if not chunk.height:
            continue
        out = root / f"dt={day}"
        out.mkdir(parents=True, exist_ok=True)
        # ONE PAST THE HIGHEST, not the count. A day whose parts have a gap in them — a
        # crash between two writes, or a compaction interrupted — has fewer files than its
        # highest index, and counting would hand back a name that already exists and
        # overwrite somebody else's rows.
        used = [int(q.stem.split("-")[-1]) for q in out.glob("part-*.parquet")
                if q.stem.split("-")[-1].isdigit()]
        n = max(used) + 1 if used else 0
        tmp = out / f".part-{n:05d}.parquet.tmp"
        chunk.write_parquet(tmp)
        tmp.rename(out / f"part-{n:05d}.parquet")   # rename is atomic within a directory
        written[day] = chunk.height
    return written


def read_days(root: Path, from_ts: int | None = None, to_ts: int | None = None,
              dedup_on: tuple[str, ...] = ("block", "log_index"),
              margin_days: int = 1) -> pl.DataFrame:
    """Read the day directories a window touches, plus a margin.

    THE MARGIN IS NOT SLOP. Until every block time is measured, a row's day comes from
    interpolation, and the measured error is around 100 seconds -- so a row that happened
    at 23:59:10 can be filed under the next day. About 0.14% of rows sit within a hundred
    seconds of a UTC midnight. Reading a day either side makes that impossible to lose:
    the partition is a coarse index for deciding what to open, and correctness comes from
    the caller filtering on ts afterwards. Without the margin the partitioning would have
    quietly dropped a couple of thousand swaps per window.
    """
    root = Path(root)
    if not root.exists():
        raise FileNotFoundError(f"no partitioned tape at {root}")
    wanted = None
    if from_ts is not None and to_ts is not None:
        pad = max(0, int(margin_days)) * DAY
        wanted = set(days_in(int(from_ts) - pad, int(to_ts) + pad))
    frames = []
    for d in sorted(root.glob("dt=*")):
        if wanted is not None and d.name[3:] not in wanted:
            continue
        for p in sorted(d.glob("part-*.parquet")):
            try:
                frames.append(pl.read_parquet(p))
            except Exception:       # noqa: BLE001
                # A part truncated by a crash is dropped, not fatal: the range it covered
                # is replayed by the next cycle, and identity dedup makes that safe.
                continue
    if not frames:
        return pl.DataFrame()
    out = pl.concat(frames, how="vertical_relaxed")
    have = [c for c in dedup_on if c in out.columns]
    return out.unique(subset=have) if have else out


def partition_summary(root: Path) -> dict:
    """What is on disk, for the build manifest and for the verification gates."""
    root = Path(root)
    days = sorted(d.name[3:] for d in root.glob("dt=*")) if root.exists() else []
    rows = 0
    for d in days:
        for p in (root / f"dt={d}").glob("part-*.parquet"):
            rows += pl.read_parquet(p, columns=["block"]).height
    return {"root": str(root), "days": len(days), "first": days[0] if days else None,
            "last": days[-1] if days else None, "rows": rows}


CURSOR = "_partitioned.json"


def _cursor(dst: Path) -> dict[str, dict]:
    """Which source parts this tree has partitioned: size on disk and rows consumed."""
    path = Path(dst) / CURSOR
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text())
    except (ValueError, OSError):
        return {}
    out: dict[str, dict] = {}
    for k, v in raw.items():
        # The first version of this file recorded a bare size. Read either.
        out[str(k)] = {"size": int(v), "rows": 0} if isinstance(v, int) else {
            "size": int(v.get("size", 0)), "rows": int(v.get("rows", 0))}
    return out


def migrate(src: Path, dst: Path, clock: BlockClock, incremental: bool = True) -> dict:
    """Flat part files -> day directories, with the measured/interpolated split.

    ONLY THE PARTS THAT ARE NEW. This was written as a one-off migration and then wired
    into the cycle, where it ran every fifteen minutes and re-partitioned the WHOLE tape
    each time: write_days() never rewrites an existing part, so each run appended a fresh
    complete copy of every day it touched. Two days of that put 43 GB of duplicate parquet
    on a 48.8 GB volume — 162 copies of each day — while the flat tapes it was copying
    came to 333 MB. Every figure on the site was still correct, because read_days() dedups
    on (block, log_index), which is exactly why nothing caught it.

    So the destination remembers which source parts it has consumed, by name and size. The
    ingest appends new parts and only ever rewrites the one it is currently filling, so a
    part whose size has changed is partitioned again and the reader's dedup absorbs the
    overlap — a few megabytes, once, instead of the whole tape every cycle.
    """
    parts = sorted(Path(src).glob("part-*.parquet")) or sorted(Path(src).rglob("*.parquet"))
    if not parts:
        raise FileNotFoundError(f"nothing to migrate at {src}")
    seen = _cursor(dst) if incremental else {}
    todo = [p for p in parts if (seen.get(p.name) or {}).get("size") != p.stat().st_size]
    if not todo:
        return {"source_rows": 0, "written": 0, "days": 0, "measured": 0,
                "interpolated": 0, "skipped_parts": len(parts), "new_parts": 0}
    # ONLY THE ROWS THAT ARE NEW, EVEN INSIDE A PART THAT GREW. The ingest keeps appending
    # to the part it is currently filling, so that one file comes back every cycle with a
    # different size. Re-partitioning all of it would copy its whole contents again — and
    # the reader would dedup them, so the only trace is bytes on the volume, which is the
    # shape of the bug this whole cursor exists for. Parts are append-only in row order, so
    # the rows already consumed are exactly the first N.
    #
    # DIAGONAL, NOT VERTICAL. The ingest's schema has changed once already — older parts of
    # the RWA tape carry 13 columns where newer ones carry 15 — and "vertical_relaxed"
    # reconciles dtypes but not a column that is simply absent, so a concat over both
    # generations dies with "schema lengths differ". Diagonal unions the columns and fills
    # the gaps with nulls, which is what an older part not having recorded block_hash
    # actually means. Every consumer selects the columns it needs by name.
    frames, consumed = [], {}
    for p in todo:
        one = pl.read_parquet(p)
        already = (seen.get(p.name) or {}).get("rows", 0)
        consumed[p.name] = one.height
        if already and already < one.height:
            one = one.slice(already)
        elif already >= one.height and already:
            continue                                # rewritten shorter; nothing new to take
        frames.append(one)
    if not frames:
        return {"source_rows": 0, "written": 0, "days": 0, "measured": 0,
                "interpolated": 0, "skipped_parts": len(parts), "new_parts": 0}
    df = pl.concat(frames, how="diagonal_relaxed")
    blocks = df["block"].to_numpy().astype(np.int64)
    ts = clock.ts_of(blocks)
    measured = int(clock.is_measured(blocks).sum())
    written = write_days(df, Path(dst), ts)
    report = {"source_rows": df.height, "written": sum(written.values()),
              "days": len(written), "measured": measured,
              "interpolated": int(df.height - measured),
              "skipped_parts": len(parts) - len(todo), "new_parts": len(todo)}
    (Path(dst) / "_migration.json").write_text(json.dumps(report, indent=1))
    # Written AFTER the parts land: a crash between the two costs one part re-partitioned
    # next cycle, which the reader's dedup absorbs. The other order would lose rows.
    cursor = dict(seen)
    for p in todo:
        cursor[p.name] = {"size": p.stat().st_size, "rows": consumed.get(p.name, 0)}
    (Path(dst) / CURSOR).write_text(json.dumps(cursor, indent=1, sort_keys=True))
    return report


def compact(root: Path, dedup_on: tuple[str, ...] = ("block", "log_index"),
            min_parts: int = 2) -> dict:
    """Rewrite each day as ONE deduped part, and drop the parts it replaces.

    The repair for the tree the cycle filled with copies, and worth running on its own
    schedule afterwards: even appending only new rows leaves a part per cycle per day, and
    a day that has been open for 96 cycles is 96 files the reader opens to answer one
    window.

    SAFE TO INTERRUPT. The merged file is written under a temporary name and renamed into
    place before any original is removed, so a crash leaves both the old parts and a
    complete new one — which the reader dedups — rather than a day with a hole in it.
    """
    root = Path(root)
    report = {"days": 0, "parts_before": 0, "parts_after": 0, "bytes_before": 0,
              "bytes_after": 0, "rows": 0}
    for day in sorted(root.glob("dt=*")):
        parts = sorted(day.glob("part-*.parquet"))
        # A threshold, not "more than one": merging a day costs writing that whole day
        # again, so doing it every cycle would churn ~80 MB per tape per cycle to save a
        # few file handles. Left to accumulate a day's worth of small parts first.
        if len(parts) < max(2, min_parts):
            continue
        # ONE PART AT A TIME, DEDUPED AS IT GOES. A day on the volume this repairs is 1.9 GB
        # across 162 copies of itself; reading them all into one frame before deduping wants
        # several gigabytes of RAM for a result that is 12 MB, and the container would be
        # killed rather than repaired. Folding each part into a running deduped frame keeps
        # the peak at one deduped day plus one part.
        #
        # Diagonal for the same reason migrate() is: a day can hold parts from two
        # generations of the ingest's schema, and the older one is missing columns rather
        # than disagreeing about their type.
        df = None
        for p in parts:
            try:
                one = pl.read_parquet(p)
            except Exception:                       # noqa: BLE001
                continue                            # a part a crash left short
            df = one if df is None else pl.concat([df, one], how="diagonal_relaxed")
            have = tuple(c for c in dedup_on if c in df.columns)
            if have:
                df = df.unique(subset=have)
        if df is None or not df.height:
            continue
        before = sum(p.stat().st_size for p in parts)
        # THE DAY IS NEVER SHORT OF ROWS, AT ANY INSTANT. The obvious order — delete the
        # originals, then rename the merged file into place — has a window between the two
        # where a kill leaves the day empty and the merged rows sitting under a dotted name
        # no reader globs. So the merged file becomes a REAL part first, under an index
        # nothing else uses; then the originals go, with the day fully readable throughout
        # (the reader dedups, so the overlap is invisible); then it takes the first index.
        # A crash at any point leaves a day that reads correctly and a spare part the next
        # compaction folds away.
        tmp = day / ".compact.parquet.tmp"
        df.write_parquet(tmp)
        staged = day / "part-99999.parquet"
        tmp.rename(staged)
        for p in parts:
            if p != staged:
                p.unlink()
        merged = day / "part-00000.parquet"
        staged.rename(merged)
        report["days"] += 1
        report["parts_before"] += len(parts)
        report["parts_after"] += 1
        report["bytes_before"] += before
        report["bytes_after"] += merged.stat().st_size
        report["rows"] += df.height
    return report


def main() -> int:
    """Migrate the flat tapes into day directories and report the split."""
    import argparse  # noqa: PLC0415
    import os  # noqa: PLC0415

    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default=None, help="migrate one tape by name")
    ap.add_argument("--compact", action="store_true",
                    help="merge each day's parts into one and drop the rest")
    ap.add_argument("--min-parts", type=int, default=2,
                    help="only compact a day that has at least this many parts")
    ap.add_argument("--full", action="store_true",
                    help="re-partition every source part, ignoring the cursor")
    args = ap.parse_args()

    root = Path(os.environ.get("PEAPOD_LP_TERMINAL", str(Path.home() / "lp-terminal")))
    clock = BlockClock.load(root)
    print(f"clock: {len(clock.blocks):,} samples, "
          f"{len(clock.measured_blocks):,} measured from the chain directly")

    tapes = {
        "swaps_tx": (HERE / "out" / "swaps_tx", HERE / "out" / "days" / "swaps_rwa"),
        "pons_swaps": (HERE / "out" / "pons_swaps", HERE / "out" / "days" / "swaps_pons"),
    }
    # WHATEVER THE SENDER TREES ARE CALLED. These were two hardcoded names, and the
    # resolver writes a tree named after the endpoint that filled it — so the one tree that
    # actually had data in it was not in this list, and partitions reported "nothing at
    # tx_from_edge, skipped" while tx_from sat beside it holding every resolved
    # transaction on the volume.
    for tree in sorted((HERE / "out").glob("tx_from*")):
        if tree.is_dir():
            tapes[tree.name] = (tree, HERE / "out" / "days" / tree.name)

    if args.compact:
        total = {"days": 0, "parts_before": 0, "parts_after": 0, "bytes_before": 0,
                 "bytes_after": 0}
        for name, (_src, dst) in tapes.items():
            if args.only and args.only != name:
                continue
            r = compact(dst, min_parts=args.min_parts)
            for k in total:
                total[k] += r[k]
            print(f"{name}: {r['days']} days, {r['parts_before']:,} parts -> "
                  f"{r['parts_after']:,}, {r['bytes_before'] / 1e9:.2f} GB -> "
                  f"{r['bytes_after'] / 1e9:.2f} GB, {r['rows']:,} rows kept")
        print(f"compacted {total['days']} day(s): {total['parts_before']:,} parts -> "
              f"{total['parts_after']:,}, freed "
              f"{(total['bytes_before'] - total['bytes_after']) / 1e9:.2f} GB")
        return 0

    for name, (src, dst) in tapes.items():
        if args.only and args.only != name:
            continue
        # A DIRECTORY IS NOT DATA. The swap ingest creates its output directory before it
        # fetches anything, so an `exists()` test passes over an empty one and migrate()
        # then raises FileNotFoundError("nothing to migrate") — a stage failing because an
        # earlier stage succeeded and found no rows.
        if not sorted(src.glob("part-*.parquet")) and not sorted(src.rglob("*.parquet")):
            print(f"{name}: no parts at {src}, skipped")
            continue
        report = migrate(src, dst, clock, incremental=not args.full)
        ok = report["source_rows"] == report["written"]
        if not report["new_parts"]:
            print(f"{name}: nothing new ({report['skipped_parts']} source parts already "
                  f"partitioned)")
            continue
        print(f"{name}: {report['source_rows']:,} rows from {report['new_parts']} new "
              f"source part(s) -> {report['days']} days, {report['measured']:,} measured / "
              f"{report['interpolated']:,} interpolated"
              f"  {'OK' if ok else 'ROW COUNT MISMATCH'}")
        if not ok:
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
