"""The pool and token registry, vendored.

WHY IT IS IN THE REPOSITORY. The build reads pools, tokens and block times on every cycle.
They lived in ~/lp-terminal, which is not in this repository and is not in the container,
so deploying meant seeding 76 MB onto a volume before anything could run — and the
container could not start without it. That is a chicken and egg, and it stopped a deploy.

WHY IT IS 1.3 MB AND NOT 76. The full registry is 762,193 pools. The build prices 326 of
them. What is vendored is the whole DEFINABLE universe, not just what has traded: every
tokenized equity against a quote asset, every Pons basket pool, and every ETH/USDG pool
that the price series might pick as its reference. A pool that lists tomorrow and trades
tomorrow is already here; only a genuinely new TOKEN needs a refresh, and
`unknown_pools()` reports that as a number rather than dropping its swaps in silence.

PEAPOD_LP_TERMINAL still wins when it is set, so a machine with the full checkout keeps
reading the real thing and `python export/registry.py --refresh` regenerates the vendored
copy from it.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import polars as pl

HERE = Path(__file__).resolve().parent
VENDORED = HERE.parent / "registry"
NATIVE = "0x0000000000000000000000000000000000000000"


def _upstream() -> Path | None:
    raw = os.environ.get("PEAPOD_LP_TERMINAL", "")
    if not raw:
        return None
    root = Path(raw).expanduser()
    return root if (root / "out" / "raw" / "pools").is_dir() else None


def pools() -> pl.DataFrame:
    up = _upstream()
    if up:
        return pl.concat([pl.read_parquet(p)
                          for p in sorted((up / "out" / "raw" / "pools").glob("part-*.parquet"))])
    return pl.read_parquet(VENDORED / "pools.parquet")


def tokens() -> pl.DataFrame:
    up = _upstream()
    if up:
        return pl.read_parquet(up / "out" / "raw" / "tokens" / "part-00000.parquet")
    return pl.read_parquet(VENDORED / "tokens.parquet")


def block_times() -> pl.DataFrame:
    up = _upstream()
    path = (up / "out" / "block_times.parquet") if up else (VENDORED / "block_times.parquet")
    return pl.read_parquet(path)


def basket() -> dict:
    """The Pons basket. Also vendored: it lived in a third repository."""
    external = Path("/Users/sentientai/canopy/data/pons-basket.json")
    if external.exists():
        return json.loads(external.read_text())
    return json.loads((VENDORED / "pons-basket.json").read_text())


def unknown_pools(traded_ids) -> list[str]:
    """Pool ids in the tape that the registry does not describe.

    A pool the registry has never heard of has its swaps dropped by the inner join, which
    is silent. This turns that into a number the gates can refuse to commit on.
    """
    known = set(pools()["pool_id"].to_list())
    return sorted(set(traded_ids) - known)


def refresh() -> int:
    """Regenerate the vendored copy from a full lp-terminal checkout."""
    up = _upstream()
    if not up:
        raise SystemExit("PEAPOD_LP_TERMINAL must point at a full checkout to refresh")
    allp, allt = pools(), tokens()
    ids = {t["pair"] for t in basket()["tokens"] if t.get("pair")}
    usdg = set(allt.filter(pl.col("symbol") == "USDG")["address"].to_list())
    rwa = set(allt.filter(pl.col("kind") == "rwa_spot")["address"].to_list())
    quote = usdg | {NATIVE}
    keep = allp.filter(
        (pl.col("currency0").is_in(list(rwa)) & pl.col("currency1").is_in(list(quote)))
        | (pl.col("currency1").is_in(list(rwa)) & pl.col("currency0").is_in(list(quote)))
        | pl.col("pool_id").is_in(list(ids))
        | ((pl.col("currency0") == NATIVE) & pl.col("currency1").is_in(list(usdg)))
        | ((pl.col("currency1") == NATIVE) & pl.col("currency0").is_in(list(usdg))))
    used = set(keep["currency0"].to_list()) | set(keep["currency1"].to_list())
    VENDORED.mkdir(exist_ok=True)
    keep.write_parquet(VENDORED / "pools.parquet", compression="zstd")
    allt.filter(pl.col("address").is_in(list(used))).write_parquet(
        VENDORED / "tokens.parquet", compression="zstd")
    block_times().write_parquet(VENDORED / "block_times.parquet", compression="zstd")
    (VENDORED / "pons-basket.json").write_text(json.dumps(basket(), separators=(",", ":")))
    print(f"vendored {keep.height:,} pools of {allp.height:,}, "
          f"{len(used):,} tokens of {allt.height:,}")
    return 0


if __name__ == "__main__":
    import sys
    raise SystemExit(refresh() if "--refresh" in sys.argv else 0)
