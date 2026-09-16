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
        allc = pl.concat([f.select("block", "ts") for f in frames]).unique(
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
        n = len(list(out.glob("part-*.parquet")))
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


def migrate(src: Path, dst: Path, clock: BlockClock) -> dict:
    """One-off: flat part files -> day directories, with the measured/interpolated split."""
    parts = sorted(Path(src).glob("part-*.parquet")) or sorted(Path(src).rglob("*.parquet"))
    if not parts:
        raise FileNotFoundError(f"nothing to migrate at {src}")
    df = pl.concat([pl.read_parquet(p) for p in parts], how="vertical_relaxed")
    blocks = df["block"].to_numpy().astype(np.int64)
    ts = clock.ts_of(blocks)
    measured = int(clock.is_measured(blocks).sum())
    written = write_days(df, Path(dst), ts)
    report = {"source_rows": df.height, "written": sum(written.values()),
              "days": len(written), "measured": measured,
              "interpolated": int(df.height - measured)}
    (Path(dst) / "_migration.json").write_text(json.dumps(report, indent=1))
    return report


def main() -> int:
    """Migrate the flat tapes into day directories and report the split."""
    import argparse  # noqa: PLC0415
    import os  # noqa: PLC0415

    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default=None, help="migrate one tape by name")
    args = ap.parse_args()

    root = Path(os.environ.get("PEAPOD_LP_TERMINAL", str(Path.home() / "lp-terminal")))
    clock = BlockClock.load(root)
    print(f"clock: {len(clock.blocks):,} samples, "
          f"{len(clock.measured_blocks):,} measured from the chain directly")

    tapes = {
        "swaps_tx": (HERE / "out" / "swaps_tx", HERE / "out" / "days" / "swaps_rwa"),
        "pons_swaps": (HERE / "out" / "pons_swaps", HERE / "out" / "days" / "swaps_pons"),
        "tx_from_edge": (HERE / "out" / "tx_from_edge", HERE / "out" / "days" / "tx_from"),
        "tx_from_pons": (HERE / "out" / "tx_from_pons",
                         HERE / "out" / "days" / "tx_from_pons"),
    }
    for name, (src, dst) in tapes.items():
        if args.only and args.only != name:
            continue
        if not src.exists():
            print(f"{name}: nothing at {src}, skipped")
            continue
        report = migrate(src, dst, clock)
        ok = report["source_rows"] == report["written"]
        print(f"{name}: {report['source_rows']:,} rows -> {report['days']} days, "
              f"{report['measured']:,} measured / {report['interpolated']:,} interpolated"
              f"  {'OK' if ok else 'ROW COUNT MISMATCH'}")
        if not ok:
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
