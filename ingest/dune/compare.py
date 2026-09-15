"""Assert Dune's tx.from mapping equals peapod's own, row for row, over their overlap.

This is the gate on using Dune at all. A single disagreement stops the run: two
independent derivations of the same chain fact either agree everywhere or one of them is
wrong, and averaging them would be worse than using neither.

Exits 0 only on exact agreement over the overlap. Any mismatch exits 1 and prints the
disagreeing rows.

Usage:  uv run python ingest/dune/compare.py [--source public|edge]
"""

from __future__ import annotations

import argparse
from pathlib import Path

import polars as pl

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "out"


def load(directory: Path, label: str) -> pl.DataFrame:
    parts = sorted(directory.glob("part-*.parquet"))
    if not parts:
        raise SystemExit(f"no {label} data at {directory}")
    frame = pl.concat([pl.read_parquet(p) for p in parts]).select("tx_hash", "tx_from")
    return frame.with_columns(pl.col("tx_from").str.to_lowercase()).unique(subset=["tx_hash"])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--left", default="public", help="public | edge | dune")
    ap.add_argument("--right", default="dune", help="public | edge | dune")
    args = ap.parse_args()

    def where(name: str) -> Path:
        return OUT / ("tx_from" if name == "public" else f"tx_from_{name}")

    ours = load(where(args.left), args.left)
    theirs = load(where(args.right), args.right)
    args.source = args.left

    print(f"{args.left}: {len(ours):,} transactions")
    print(f"{args.right}: {len(theirs):,} transactions")

    joined = ours.join(theirs, on="tx_hash", how="inner", suffix="_dune")
    print(f"overlap:    {len(joined):,} transactions")
    if len(joined) == 0:
        raise SystemExit("no overlap to compare; nothing has been verified")

    disagree = joined.filter(pl.col("tx_from") != pl.col("tx_from_dune"))
    print(f"\ndisagreements: {len(disagree):,}")
    if len(disagree) > 0:
        print("\nSTOPPING. Two independent derivations disagree on a raw chain fact:")
        for row in disagree.head(20).iter_rows(named=True):
            print(f"  {row['tx_hash']}")
            print(f"    {args.left:<8} {row['tx_from']}")
            print(f"    {args.right:<8} {row['tx_from_dune']}")
        if len(disagree) > 20:
            print(f"  ... and {len(disagree) - 20:,} more")
        disagree.write_parquet(OUT / "tx_from_disagreements.parquet")
        print(f"\nall disagreements written to {OUT / 'tx_from_disagreements.parquet'}")
        return 1

    only_ours = len(ours) - len(joined)
    only_theirs = len(theirs) - len(joined)
    print(f"exact agreement on all {len(joined):,} overlapping transactions")
    print(f"  in {args.left} only: {only_ours:,}   in {args.right} only: {only_theirs:,}")
    print("  (coverage differences are expected while either side is still running;")
    print("   they are not disagreements, and nothing is inferred from them)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
