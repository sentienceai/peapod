"""Per-pool +/-1% depth: current, a 7-day median, and both bases at every sample.

The depth tracker needs current depth, a 7-day median, current as a percentage of that
median, daily volume, and share of chain-wide depth. Only the first of those is a single
walk; the median needs the tick map rebuilt as it stood at each earlier sample, because
executable depth is a function of the whole book, not of a liquidity number that can be
interpolated.

So the map is advanced in block order and the band walked at each sample point, and the
reconstruction is checked against the chain at every one of them -- every Swap event
carries the pool's real active liquidity, so there is no reason to trust the replay when
it can be verified. Samples that fail the check are dropped and counted, never valued.
"""

from __future__ import annotations

import numpy as np
import polars as pl

from bandwalk import TickMap, flat_band_depth
from tapes import sane_mask

SAMPLE_HOURS = 4          # 42 samples across the 7-day window
MEDIAN_DAYS = 7


def _sample_indices(ts: np.ndarray, ok: np.ndarray, blocks: np.ndarray,
                    anchor_block: int, anchor_ts: int) -> list[int]:
    """The last usable swap in each 4-hour bucket of the 7 days before the anchor.

    Bucketing rather than taking every swap keeps the median from being dominated by the
    pools that trade most often: each bucket contributes once, so the median describes
    depth over time rather than depth per swap.
    """
    usable = np.nonzero(ok & (blocks <= anchor_block))[0]
    if len(usable) == 0:
        return []
    start = anchor_ts - MEDIAN_DAYS * 86400
    bucket = ((ts[usable] - start) // (SAMPLE_HOURS * 3600)).astype(np.int64)
    keep: dict[int, int] = {}
    for idx, b in zip(usable, bucket):
        if b >= 0:
            keep[int(b)] = int(idx)       # ascending order, so the last one wins
    keep[-1] = int(usable.max())          # the anchor sample itself
    return sorted(set(keep.values()))


def per_pool(lm, group: pl.DataFrame, mods: pl.DataFrame, anchors) -> dict | None:
    """Depth for one pool, or None if its tick map cannot be verified at the anchor."""
    px = group["px"].to_numpy()
    ok = sane_mask(px)
    ts = group["ts"].to_numpy()
    blocks = group["block"].to_numpy().astype(np.int64)
    logidx = group["log_index"].to_numpy().astype(np.int64)
    ticks = group["tick"].to_numpy().astype(np.int64)
    sqrts = [int(x) for x in group["sqrt_price_x96"].to_list()]
    liqs = [int(x) for x in group["liquidity"].to_list()]

    d0 = int(group["d0"][0] or 18)
    d1 = int(group["d1"][0] or 18)
    rwa0 = bool(group["rwa_is_0"][0])

    samples = _sample_indices(ts, ok, blocks, anchors.modify_head_block, anchors.modify_head_ts)
    if not samples:
        return None

    mb = mods["block"].to_numpy().astype(np.int64)
    ml = mods["log_index"].to_numpy().astype(np.int64)
    mtl = mods["tick_lower"].to_numpy().astype(np.int64)
    mtu = mods["tick_upper"].to_numpy().astype(np.int64)
    mdl = [int(x) for x in mods["liquidity_delta"].to_list()]

    tick_map = TickMap()
    cursor = 0
    series: list[dict] = []
    unverified = 0

    for idx in samples:
        # Advance the map through every ModifyLiquidity strictly before this swap.
        b, l = int(blocks[idx]), int(logidx[idx])
        while cursor < len(mb) and (mb[cursor] < b or (mb[cursor] == b and ml[cursor] < l)):
            tick_map.apply(int(mtl[cursor]), int(mtu[cursor]), mdl[cursor])
            cursor += 1

        L = liqs[idx]
        sp = sqrts[idx]
        tick = int(ticks[idx])
        if L <= 0 or sp <= 0:
            unverified += 1
            continue
        if not tick_map.matches(tick, L):
            unverified += 1
            continue

        executable, segments, sane = tick_map.depth(lm, sp, tick, L, d0, d1, rwa0, float(px[idx]))
        if not sane:
            unverified += 1
            continue
        series.append({
            "ts": int(ts[idx]),
            "executable": executable,
            "flat": flat_band_depth(lm, sp, L, d0, d1, rwa0, float(px[idx])),
            "segments": segments,
        })

    if not series:
        return None

    # The anchor reading is the last sample, by construction.
    current = series[-1]
    exec_series = np.array([s["executable"] for s in series])
    flat_series = np.array([s["flat"] for s in series])

    # The published control: flat-L at the swap tape's end, which is later than the anchor.
    tape_idx = int(np.max(np.nonzero(ok)[0]))
    tape_flat = (flat_band_depth(lm, sqrts[tape_idx], liqs[tape_idx], d0, d1, rwa0,
                                 float(px[tape_idx]))
                 if liqs[tape_idx] > 0 and sqrts[tape_idx] > 0 else 0.0)

    days = (int(ts.max()) - int(ts.min())) / 86400
    volume_total = float(group["notional"].sum())
    median_exec = float(np.median(exec_series))
    median_flat = float(np.median(flat_series))

    return {
        "pool_id": group["pool_id"][0],
        "ticker": group["ticker"][0],
        "depth_executable": current["executable"],
        "depth_flat": current["flat"],
        "depth_flat_at_tape_end": tape_flat,
        "median_7d_executable": median_exec,
        "median_7d_flat": median_flat,
        "pct_of_median_executable": (current["executable"] / median_exec * 100
                                     if median_exec > 0 else None),
        "pct_of_median_flat": (current["flat"] / median_flat * 100 if median_flat > 0 else None),
        "executable_over_flat_pct": (current["executable"] / current["flat"] * 100
                                     if current["flat"] > 0 else None),
        "volume_per_day_usd": volume_total / days if days > 0 else None,
        "volume_total_usd": volume_total,
        "swaps": len(group),
        "price_usd": float(px[samples[-1]]),
        "band_segments": current["segments"],
        "samples": len(series),
        "samples_unverified": unverified,
        "series": [{"ts": s["ts"], "executable": s["executable"], "flat": s["flat"]}
                   for s in series],
    }


def add_shares(rows: list[dict]) -> list[dict]:
    """Share of chain-wide depth, on both bases. Chain-wide means this universe."""
    total_exec = sum(r["depth_executable"] for r in rows) or float("nan")
    total_flat = sum(r["depth_flat"] for r in rows) or float("nan")
    for r in rows:
        r["share_of_chain_executable_pct"] = r["depth_executable"] / total_exec * 100
        r["share_of_chain_flat_pct"] = r["depth_flat"] / total_flat * 100
    return sorted(rows, key=lambda r: -r["depth_executable"])
