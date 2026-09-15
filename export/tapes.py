"""Loading lp-terminal's tapes, and fixing the universe once so nothing drifts.

Every export reads the same swap tape, pool registry and token registry, applies the same
filters, and resolves the same two anchors. Doing that in one place is what keeps
depth.json, pools.json and windows.json describing the same set of pools -- a site whose
three data files disagreed about which pools exist would be worse than one file.
"""

from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import polars as pl

Q96 = 1 << 96

# The universe filters lp-terminal's depth_distribution.py used, kept identical so the
# published figures reproduce and the comparison is not confounded by a different set.
MIN_SWAPS = 200
MIN_DAYS = 10
PRICE_MIN, PRICE_MAX = 0.01, 1e5
MIN_SANE_FRACTION = 0.95


def iso(ts: int) -> str:
    return dt.datetime.fromtimestamp(int(ts), dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass(frozen=True)
class Anchors:
    """The two times every number on the site is dated by.

    lp-terminal's ModifyLiquidity ingest finished hours before its swap ingest ran.
    Liquidity moved in between, so past `modify_head_block` the tick map is stale and
    executable depth cannot be verified against the chain. Depth is therefore taken at or
    before that block, while the swap tape itself runs later. Both are published: a reader
    is entitled to know the executable number is the older of the two.
    """

    modify_head_block: int
    modify_head_ts: int
    swap_tape_end_block: int
    swap_tape_end_ts: int

    @property
    def staleness_hours(self) -> float:
        return (self.swap_tape_end_ts - self.modify_head_ts) / 3600

    def to_json(self) -> dict:
        return {
            "executable_depth_anchor": {
                "block": self.modify_head_block,
                "ts": self.modify_head_ts,
                "iso": iso(self.modify_head_ts),
                "why": "head of the ModifyLiquidity tape; at or before this block the tick "
                       "map is complete and verifiable against the chain, after it stale",
            },
            "swap_tape_end": {
                "block": self.swap_tape_end_block,
                "ts": self.swap_tape_end_ts,
                "iso": iso(self.swap_tape_end_ts),
                "why": "head of the swap tape; volume and the published flat-L control "
                       "basis run to here",
            },
            "staleness_hours": round(self.staleness_hours, 2),
        }


def load(root: Path) -> tuple[pl.DataFrame, pl.DataFrame, Anchors]:
    """(swaps with metadata and derived price, modifies, anchors)."""
    out = root / "out"
    swaps = pl.concat([pl.read_parquet(p)
                       for p in sorted((out / "raw" / "swaps_phase4").glob("part-*.parquet"))])
    pools = pl.concat([pl.read_parquet(p)
                       for p in sorted((out / "raw" / "pools").glob("part-*.parquet"))])
    tok = pl.read_parquet(out / "raw" / "tokens" / "part-00000.parquet")

    t0 = tok.select(pl.col("address").alias("currency0"), pl.col("symbol").alias("s0"),
                    pl.col("decimals").alias("d0"), pl.col("kind").alias("k0"))
    t1 = tok.select(pl.col("address").alias("currency1"), pl.col("symbol").alias("s1"),
                    pl.col("decimals").alias("d1"), pl.col("kind").alias("k1"))
    meta = (pools.join(t0, on="currency0", how="left").join(t1, on="currency1", how="left")
            .with_columns(rwa_is_0=(pl.col("k0") == "rwa_spot"),
                          ticker=pl.when(pl.col("k0") == "rwa_spot")
                                   .then(pl.col("s0")).otherwise(pl.col("s1")),
                          quote=pl.when(pl.col("k0") == "rwa_spot")
                                  .then(pl.col("s1")).otherwise(pl.col("s0")))
            .select("pool_id", "ticker", "quote", "rwa_is_0", "d0", "d1",
                    pl.col("fee").alias("pool_fee"), "tick_spacing"))
    swaps = swaps.join(meta, on="pool_id", how="inner")

    bt = pl.read_parquet(out / "block_times.parquet").sort("block")
    blocks = bt["block"].to_numpy().astype(np.int64)
    times = bt["ts"].to_numpy().astype(np.int64)
    swaps = swaps.with_columns(ts=pl.Series(
        np.interp(swaps["block"].to_numpy().astype(np.int64), blocks, times).astype(np.int64)))

    # Price in USD per share, and swap notional in USD, exactly as depth_distribution.py
    # and session_toxicity.py derive them.
    d0 = swaps["d0"].fill_null(18).to_numpy()
    d1 = swaps["d1"].fill_null(18).to_numpy()
    rwa0 = swaps["rwa_is_0"].to_numpy()
    sp = swaps["sqrt_price_x96"].cast(pl.Float64).to_numpy()
    p10 = (sp / Q96) ** 2 * (10.0 ** (d0 - d1))
    with np.errstate(divide="ignore", invalid="ignore"):
        px = np.where(rwa0, p10, np.where(p10 > 0, 1.0 / p10, np.nan))
    a0 = swaps["amount0"].cast(pl.Float64).to_numpy()
    a1 = swaps["amount1"].cast(pl.Float64).to_numpy()
    notional = np.abs(np.where(rwa0, a1 / 10.0 ** d1, a0 / 10.0 ** d0))
    swaps = swaps.with_columns(px=pl.Series(px), notional=pl.Series(notional))

    mods = pl.concat([pl.read_parquet(p)
                      for p in sorted((out / "raw" / "modifyliquidity").glob("part-*.parquet"))]
                     ).filter(pl.col("pool_id").is_in(swaps["pool_id"].unique().implode()))

    modify_head = int(mods["block"].max())
    tape_end = int(swaps["block"].max())
    anchors = Anchors(
        modify_head_block=modify_head,
        modify_head_ts=int(np.interp(modify_head, blocks, times)),
        swap_tape_end_block=tape_end,
        swap_tape_end_ts=int(np.interp(tape_end, blocks, times)),
    )
    return swaps.sort(["pool_id", "block", "log_index"]), mods.sort(["pool_id", "block", "log_index"]), anchors


def sane_mask(px: np.ndarray) -> np.ndarray:
    return np.isfinite(px) & (px > PRICE_MIN) & (px < PRICE_MAX)


def in_universe(group: pl.DataFrame) -> tuple[bool, str]:
    """The depth universe test, with a reason when a pool fails it."""
    if len(group) < MIN_SWAPS:
        return False, "too_few_swaps"
    ok = sane_mask(group["px"].to_numpy())
    if ok.mean() < MIN_SANE_FRACTION:
        return False, "degenerate_price"
    days = (int(group["ts"].max()) - int(group["ts"].min())) / 86400
    if days < MIN_DAYS:
        return False, "too_short_a_history"
    return True, ""


def ticks_for_pct(pct: float) -> int:
    """Half-width in ticks for a +/-pct range, as range_backtest.py computes it."""
    return int(round(math.log(1 + pct) / math.log(1.0001)))


def expressible_widths(tick_spacing: int, widths: dict[str, float]) -> list[str]:
    """Which widths a pool's tick spacing can actually express.

    TICK SPACING IS BINDING, and lp-terminal found it binding for most pools: a spacing
    coarser than the half-width means the tightest position the pool can hold is wider
    than the range asked for. Such widths are skipped, never silently widened.
    """
    return [name for name, pct in widths.items() if tick_spacing <= ticks_for_pct(pct)]
