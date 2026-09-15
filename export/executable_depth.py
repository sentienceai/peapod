"""Executable +/-1% depth: the tick-map walk.

WHAT THIS REPLACES. lp-terminal's engine/depth_distribution.py values a pool's +/-1%
band with ONE liquidity value -- the active L at the current tick -- held flat across the
whole band. Its own Limitations section says so: "If positions' ranges end inside +/-1%,
true depth is lower... the absolute level is an upper bound." peapod headlines "real
executable depth, not TVL", so it cannot ship that upper bound.

This walks the actual tick liquidity map instead. The band is split at every initialized
tick the price would cross, each segment is valued with the liquidity that is genuinely
active there, and the segments are summed. Positions whose ranges end inside the band stop
contributing at the tick where they end, which is what "executable" means.

THE TICK MAP IS VERIFIED, NOT ASSUMED. Active liquidity at the current tick is the sum of
liquidityNet over all ticks at or below it. Every Swap event carries `result.liquidity` --
the pool's real active liquidity after that swap -- so the reconstruction is checked
against the chain at the anchor swap for every pool. Pools that do not reconstruct exactly
are excluded and counted, never silently valued.

THE ANCHOR. lp-terminal's ModifyLiquidity ingest completed at head 62,264,735; its
swaps_phase4 ingest ran five hours later, to 62,441,080. Liquidity moved in between, so at
the swap tape's end the tick map is stale and 19 of the top 25 pools fail to reconstruct.
Depth is therefore taken at each pool's last swap AT OR BEFORE the ModifyLiquidity head,
where the map is complete and provable. That costs five hours of freshness and buys a
number that can be checked against the chain.

Both bases are computed at that same anchor so the comparison isolates the method rather
than the five-hour shift, and the published flat-L figure is reproduced at the original
tape end as a control.

Usage:  PEAPOD_LP_TERMINAL=~/lp-terminal python export/executable_depth.py
"""

from __future__ import annotations

import json
import math
import os
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import polars as pl

# --------------------------------------------------------------------- upstream

LP = os.environ.get("PEAPOD_LP_TERMINAL", "")
if not LP:
    sys.exit(
        "\nexecutable depth computation failed:\n"
        "  PEAPOD_LP_TERMINAL is not set.\n\n"
        "  It must point at an lp-terminal checkout, which supplies the swap and\n"
        "  ModifyLiquidity tapes under out/raw/ and the v4 math in engine/:\n\n"
        "    PEAPOD_LP_TERMINAL=~/lp-terminal python export/executable_depth.py\n"
    )
LP = Path(LP).expanduser()
for probe, what in [
    ("engine/liquidity_math.py", "the v4 math engine"),
    ("out/raw/swaps_phase4", "the swap tape"),
    ("out/raw/modifyliquidity", "the ModifyLiquidity tape"),
    ("out/block_times.parquet", "the block-time index"),
]:
    if not (LP / probe).exists():
        sys.exit(f"\nexecutable depth computation failed:\n  missing {what}: {LP / probe}\n")

sys.path.insert(0, str(LP / "engine"))
from liquidity_math import get_amount0_delta, get_amount1_delta, get_sqrt_price_at_tick  # noqa: E402

OUT = LP / "out"
HERE = Path(__file__).resolve().parent

Q96 = 1 << 96
# Same universe filters as depth_distribution.py, so the two are directly comparable.
MIN_SWAPS, MIN_DAYS = 200, 10
PRICE_MIN, PRICE_MAX = 0.01, 1e5
BAND = 0.01

# ------------------------------------------------------------------ band walks


def flat_band_depth(sqrt_p: int, L: int, d0: int, d1: int, rwa0: bool, px: float) -> float:
    """depth_distribution.py's band_depth, unchanged. One L, held flat across the band."""
    lo = int(sqrt_p * math.sqrt(1 / (1 + BAND)))
    hi = int(sqrt_p * math.sqrt(1 + BAND))
    a0 = get_amount0_delta(sqrt_p, hi, L, False)
    a1 = get_amount1_delta(lo, sqrt_p, L, False)
    rwa_amt = (a0 / 10 ** d0) if rwa0 else (a1 / 10 ** d1)
    usd_amt = (a1 / 10 ** d1) if rwa0 else (a0 / 10 ** d0)
    return rwa_amt * px + usd_amt


def walk_band_depth(
    sqrt_p: int, tick_now: int, L0: int, ticks: list[int], net: dict[int, int],
    d0: int, d1: int, rwa0: bool, px: float,
) -> tuple[float, int, bool]:
    """Executable depth: split the band at every initialized tick and sum the segments.

    Crossing convention is Pool.swap's, the same one pool_state.PoolState.apply_swap and
    fee_attribution.split_swap_at_ticks use: going up, liquidity += liquidityNet[t] on
    crossing t; going down, liquidity -= liquidityNet[t]. Boundaries are compared in sqrt
    price, so a tick the price does not actually reach is not crossed.

    Returns (depth_usd, segments_walked, liquidity_stayed_non_negative).
    """
    lo = int(sqrt_p * math.sqrt(1 / (1 + BAND)))
    hi = int(sqrt_p * math.sqrt(1 + BAND))
    segments = 0
    sane = True

    # Upward: token0 the pool would sell as the price rises to +1%.
    # Going up, every initialized tick t with tick_now < t <= tick_at(hi) is crossed and
    # its liquidityNet applied. A tick whose boundary coincides with the current price
    # contributes no segment but MUST still be crossed -- skipping the crossing because
    # the segment is empty leaves every later segment on the wrong liquidity.
    a0 = 0
    cur, L = sqrt_p, L0
    for t in ticks:
        if t <= tick_now:
            continue
        b = get_sqrt_price_at_tick(t)
        if b > hi:
            break
        if b > cur:
            if L > 0:
                a0 += get_amount0_delta(cur, b, L, False)
            segments += 1
            cur = b
        L += net[t]
        if L < 0:
            sane = False
            L = 0
    if cur < hi and L > 0:
        a0 += get_amount0_delta(cur, hi, L, False)

    # Downward: token1 the pool would sell as the price falls to -1%.
    # Going down, the ticks crossed are those with tick_at(lo) < t <= tick_now -- note the
    # inclusive upper end, so a tick equal to the current tick IS crossed.
    a1 = 0
    cur, L = sqrt_p, L0
    for t in reversed(ticks):
        if t > tick_now:
            continue
        b = get_sqrt_price_at_tick(t)
        if b < lo:
            break
        if b < cur:
            if L > 0:
                a1 += get_amount1_delta(b, cur, L, False)
            segments += 1
            cur = b
        L -= net[t]
        if L < 0:
            sane = False
            L = 0
    if cur > lo and L > 0:
        a1 += get_amount1_delta(lo, cur, L, False)

    rwa_amt = (a0 / 10 ** d0) if rwa0 else (a1 / 10 ** d1)
    usd_amt = (a1 / 10 ** d1) if rwa0 else (a0 / 10 ** d0)
    return rwa_amt * px + usd_amt, segments, sane


# ------------------------------------------------------------------------ data


def load_swaps() -> pl.DataFrame:
    swaps = pl.concat([pl.read_parquet(p)
                       for p in sorted((OUT / "raw" / "swaps_phase4").glob("part-*.parquet"))])
    pools = pl.concat([pl.read_parquet(p)
                       for p in sorted((OUT / "raw" / "pools").glob("part-*.parquet"))])
    tok = pl.read_parquet(OUT / "raw" / "tokens" / "part-00000.parquet")
    t0 = tok.select(pl.col("address").alias("currency0"), pl.col("symbol").alias("s0"),
                    pl.col("decimals").alias("d0"), pl.col("kind").alias("k0"))
    t1 = tok.select(pl.col("address").alias("currency1"), pl.col("symbol").alias("s1"),
                    pl.col("decimals").alias("d1"), pl.col("kind").alias("k1"))
    meta = (pools.join(t0, on="currency0", how="left").join(t1, on="currency1", how="left")
            .with_columns(rwa_is_0=(pl.col("k0") == "rwa_spot"),
                          ticker=pl.when(pl.col("k0") == "rwa_spot")
                                   .then(pl.col("s0")).otherwise(pl.col("s1")))
            .select("pool_id", "ticker", "rwa_is_0", "d0", "d1"))
    return swaps.join(meta, on="pool_id", how="inner")


def main() -> int:
    df = load_swaps()
    bt = pl.read_parquet(OUT / "block_times.parquet").sort("block")
    blocks = bt["block"].to_numpy().astype(np.int64)
    times = bt["ts"].to_numpy().astype(np.int64)
    df = df.with_columns(ts=pl.Series(
        np.interp(df["block"].to_numpy().astype(np.int64), blocks, times).astype(np.int64)))

    mods = pl.concat([pl.read_parquet(p)
                      for p in sorted((OUT / "raw" / "modifyliquidity").glob("part-*.parquet"))]
                     ).filter(pl.col("pool_id").is_in(df["pool_id"].unique().implode()))

    # The anchor: the last block the ModifyLiquidity tape covers. Past it the tick map is
    # incomplete, so any depth computed there is unverifiable.
    anchor_block = int(mods["block"].max())
    tape_end_block = int(df["block"].max())
    anchor_ts = int(np.interp(anchor_block, blocks, times))
    tape_end_ts = int(np.interp(tape_end_block, blocks, times))

    d0a = df["d0"].fill_null(18).to_numpy()
    d1a = df["d1"].fill_null(18).to_numpy()
    rwa0a = df["rwa_is_0"].to_numpy()
    sp = df["sqrt_price_x96"].cast(pl.Float64).to_numpy()
    p10 = (sp / Q96) ** 2 * (10.0 ** (d0a - d1a))
    with np.errstate(divide="ignore", invalid="ignore"):
        px = np.where(rwa0a, p10, np.where(p10 > 0, 1.0 / p10, np.nan))
    a0 = df["amount0"].cast(pl.Float64).to_numpy()
    a1 = df["amount1"].cast(pl.Float64).to_numpy()
    notional = np.abs(np.where(rwa0a, a1 / 10.0 ** d1a, a0 / 10.0 ** d0a))
    df = df.with_columns(px=pl.Series(px), notional=pl.Series(notional))

    mod_by_pool: dict[str, pl.DataFrame] = {
        pid: g for (pid,), g in mods.group_by(["pool_id"], maintain_order=True)
    }

    rows: list[dict] = []
    excluded = {"filters": 0, "no_swap_before_anchor": 0, "map_mismatch": 0, "degenerate": 0}
    mismatches: list[dict] = []

    for (pid,), g in df.sort(["block", "log_index"]).group_by(["pool_id"], maintain_order=True):
        if len(g) < MIN_SWAPS:
            excluded["filters"] += 1
            continue
        p = g["px"].to_numpy()
        ok = np.isfinite(p) & (p > PRICE_MIN) & (p < PRICE_MAX)
        if ok.mean() < 0.95:
            excluded["filters"] += 1
            continue
        days = (int(g["ts"].max()) - int(g["ts"].min())) / 86400
        if days < MIN_DAYS:
            excluded["filters"] += 1
            continue

        d0 = int(g["d0"][0] or 18)
        d1 = int(g["d1"][0] or 18)
        rwa0 = bool(g["rwa_is_0"][0])
        gb = g["block"].to_numpy()

        # The published basis: last sane swap on the full tape.
        idx_tape = int(np.max(np.nonzero(ok)[0]))
        # The verifiable basis: last sane swap at or before the ModifyLiquidity head.
        eligible = np.nonzero(ok & (gb <= anchor_block))[0]
        if len(eligible) == 0:
            excluded["no_swap_before_anchor"] += 1
            continue
        idx = int(eligible.max())

        L_now = int(g["liquidity"][idx])
        sp_now = int(g["sqrt_price_x96"][idx])
        tick_now = int(g["tick"][idx])
        px_now = float(p[idx])
        if L_now <= 0 or sp_now <= 0:
            excluded["degenerate"] += 1
            continue

        # Build the tick map from every ModifyLiquidity strictly before the anchor swap.
        m = mod_by_pool.get(pid)
        net: dict[int, int] = defaultdict(int)
        if m is not None:
            ab, ai = int(g["block"][idx]), int(g["log_index"][idx])
            m = m.filter((pl.col("block") < ab)
                         | ((pl.col("block") == ab) & (pl.col("log_index") < ai)))
            for tl, tu, dl in zip(m["tick_lower"], m["tick_upper"], m["liquidity_delta"]):
                dl = int(dl)
                net[int(tl)] += dl
                net[int(tu)] -= dl
        net = {t: v for t, v in net.items() if v != 0}

        # Check the map against the chain's own reading before trusting it.
        L_replayed = sum(v for t, v in net.items() if t <= tick_now)
        if L_replayed != L_now:
            excluded["map_mismatch"] += 1
            mismatches.append({"pool_id": pid, "ticker": g["ticker"][0],
                               "reported": L_now, "replayed": L_replayed})
            continue

        ticks = sorted(net)
        depth_flat = flat_band_depth(sp_now, L_now, d0, d1, rwa0, px_now)
        depth_exec, segments, sane = walk_band_depth(
            sp_now, tick_now, L_now, ticks, net, d0, d1, rwa0, px_now)
        if not sane:
            excluded["degenerate"] += 1
            continue

        # Published basis, for the control line only.
        L_tape = int(g["liquidity"][idx_tape])
        sp_tape = int(g["sqrt_price_x96"][idx_tape])
        depth_tape_flat = (flat_band_depth(sp_tape, L_tape, d0, d1, rwa0, float(p[idx_tape]))
                           if L_tape > 0 and sp_tape > 0 else 0.0)

        vol = float(g["notional"].sum())
        rows.append({
            "pool_id": pid, "ticker": g["ticker"][0],
            "depth_exec": depth_exec, "depth_flat": depth_flat,
            "depth_tape_flat": depth_tape_flat,
            "ratio": depth_exec / depth_flat if depth_flat > 0 else float("nan"),
            "segments": segments, "initialized_ticks": len(ticks),
            "vol_per_day": vol / days if days > 0 else float("nan"),
            "swaps": len(g),
        })

    r = pl.DataFrame(rows).sort("depth_exec", descending=True)
    report(r, excluded, mismatches, anchor_block, anchor_ts, tape_end_block, tape_end_ts)
    write_json(r, excluded, anchor_block, anchor_ts, tape_end_block, tape_end_ts)
    return 0


# ---------------------------------------------------------------------- report


def _share(series: np.ndarray, n: int) -> float:
    return float(series[:n].sum()) / float(series.sum()) * 100 if series.sum() else float("nan")


def report(r, excluded, mismatches, anchor_block, anchor_ts, tape_end_block, tape_end_ts):
    import datetime as dt
    fmt = lambda t: dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    print("=" * 88)
    print("EXECUTABLE +/-1% DEPTH -- tick-map walk vs the flat-L upper bound")
    print("=" * 88)
    print(f"anchor block   {anchor_block:,}  {fmt(anchor_ts)}   (ModifyLiquidity tape head)")
    print(f"swap tape ends {tape_end_block:,}  {fmt(tape_end_ts)}   "
          f"({(tape_end_ts - anchor_ts) / 3600:.1f}h later; map is stale past the anchor)")
    print(f"pools valued   {len(r)}")
    print(f"excluded       {excluded}")
    if mismatches:
        print(f"  tick-map mismatches ({len(mismatches)}), worst by |delta|:")
        for m in sorted(mismatches, key=lambda x: -abs(x["reported"] - x["replayed"]))[:5]:
            d = (m["replayed"] - m["reported"]) / m["reported"] * 100 if m["reported"] else float("nan")
            print(f"    {m['ticker']:<7} {m['pool_id'][:10]}  reported {m['reported']:>26,}  "
                  f"replayed {m['replayed']:>26,}  {d:+.2f}%")

    ex = r["depth_exec"].to_numpy()
    fl = r["depth_flat"].to_numpy()
    tp = r["depth_tape_flat"].to_numpy()

    print("\n" + "=" * 88)
    print("CONCENTRATION -- what 80.8% becomes")
    print("=" * 88)
    print(f"{'basket':<10} {'flat-L @ tape end':>20} {'flat-L @ anchor':>20} {'EXECUTABLE @ anchor':>22}")
    order_tp = np.sort(tp)[::-1]
    order_fl = np.sort(fl)[::-1]
    for n in (1, 5, 10, 25):
        n_ = min(n, len(r))
        print(f"{'top ' + str(n):<10} {_share(order_tp, n_):>19.1f}% {_share(order_fl, n_):>19.1f}% "
              f"{_share(ex, n_):>21.1f}%")
    print(f"{'total $':<10} {order_tp.sum():>20,.0f} {order_fl.sum():>20,.0f} {ex.sum():>22,.0f}")

    print("\n" + "=" * 88)
    print("TOP 10 BY EXECUTABLE DEPTH")
    print("=" * 88)
    print(f"{'#':>2} {'ticker':<7} {'pool':<12} {'executable $':>14} {'flat-L $':>14} "
          f"{'exec/flat':>10} {'segs':>6} {'ticks':>7}")
    for i, row in enumerate(r.head(10).iter_rows(named=True), 1):
        print(f"{i:>2} {row['ticker']:<7} {row['pool_id'][:10]:<12} {row['depth_exec']:>14,.0f} "
              f"{row['depth_flat']:>14,.0f} {row['ratio'] * 100:>9.1f}% {row['segments']:>6} "
              f"{row['initialized_ticks']:>7,}")

    ratios = r.filter(pl.col("depth_flat") > 1)["ratio"].to_numpy() * 100
    if len(ratios):
        print("\nexecutable as % of the flat-L bound, across pools with a real book:")
        print("  " + "  ".join(f"p{q}={np.percentile(ratios, q):.0f}%" for q in (5, 25, 50, 75, 95)))


def write_json(r, excluded, anchor_block, anchor_ts, tape_end_block, tape_end_ts):
    ex = r["depth_exec"].to_numpy()
    payload = {
        "basis": "executable_pm1pct_depth_tick_map_walk",
        "anchor": {"block": anchor_block, "ts": anchor_ts,
                   "why": "ModifyLiquidity tape head; the tick map is complete and "
                          "chain-verified at or before this block, and stale after it"},
        "swap_tape_end": {"block": tape_end_block, "ts": tape_end_ts},
        "pools_valued": len(r),
        "excluded": excluded,
        "chain_wide_depth_usd": float(ex.sum()),
        "top1_share_pct": _share(ex, 1),
        "subsidy_caveat": "Robinhood Chain ran under a gas subsidy ending 2026-09-29. "
                          "Every figure here predates the real cost regime and is provisional.",
        "pools": [
            {k: (v if not isinstance(v, float) or math.isfinite(v) else None)
             for k, v in row.items()}
            for row in r.iter_rows(named=True)
        ],
    }
    dest = HERE / "executable_depth.json"
    dest.write_text(json.dumps(payload, indent=1))
    print(f"\nwrote {dest}")


if __name__ == "__main__":
    raise SystemExit(main())
