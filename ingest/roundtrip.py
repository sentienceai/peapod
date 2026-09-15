"""Who qualifies for a round-trip leaderboard, and what share of the flow they carry.

THE DEFINITION. An address enters only on completed round-trips inside the tape: it bought
a token on-DEX and later sold it on-DEX. Realized PnL is computed on the matched quantity
alone, matched first-in-first-out. Units that arrived any other way -- bridged, issued,
transferred in -- are not flagged and included at a guessed cost basis; they are out of
scope, and a sell beyond the on-DEX inventory simply matches nothing.

This ranks TRADING, not HOLDINGS. Someone who bridged in a large position and sold it made
no trading decision this can score, and scoring it would reward provenance rather than
skill. That is the reason for the definition, not a limitation of it, and the method page
should say so in those words.

WHY A WINDOW UNDERSTATES IT. A buy before the window with its sell inside is invisible as a
pair, so on any window this is a LOWER bound on who qualifies, rising as the window grows.
That is the opposite bias to the provenance question, where a window overstates. Both are
reported against window length rather than as single numbers.

Usage:  PEAPOD_LP_TERMINAL=~/lp-terminal PYTHONPATH=ingest:export \
          uv run python ingest/roundtrip.py [--source public|edge]
"""

from __future__ import annotations

import argparse
from collections import defaultdict, deque
from pathlib import Path

import numpy as np
import polars as pl

HERE = Path(__file__).resolve().parent
Q96 = 1 << 96
DUST = 1e-9


def load(root: Path, source: str) -> tuple[pl.DataFrame, float]:
    suffix = "" if source == "public" else f"_{source}"
    swaps = pl.concat([pl.read_parquet(p)
                       for p in sorted((HERE / "out" / "swaps_tx").glob("part-*.parquet"))])
    parts = sorted((HERE / "out" / f"tx_from{suffix}").glob("part-*.parquet"))
    if not parts:
        raise SystemExit(f"no resolved transactions for source '{source}'")
    senders = pl.concat([pl.read_parquet(p) for p in parts]).unique(subset=["tx_hash"])

    pools = pl.concat([pl.read_parquet(p)
                       for p in sorted((root / "out" / "raw" / "pools").glob("part-*.parquet"))])
    tok = pl.read_parquet(root / "out" / "raw" / "tokens" / "part-00000.parquet")
    t0 = tok.select(pl.col("address").alias("currency0"), pl.col("symbol").alias("s0"),
                    pl.col("decimals").alias("d0"), pl.col("kind").alias("k0"))
    t1 = tok.select(pl.col("address").alias("currency1"), pl.col("symbol").alias("s1"),
                    pl.col("decimals").alias("d1"), pl.col("kind").alias("k1"))
    meta = (pools.join(t0, on="currency0", how="left").join(t1, on="currency1", how="left")
            .with_columns(rwa0=(pl.col("k0") == "rwa_spot"),
                          ticker=pl.when(pl.col("k0") == "rwa_spot")
                                   .then(pl.col("s0")).otherwise(pl.col("s1")))
            .select("pool_id", "ticker", "rwa0", "d0", "d1"))

    df = swaps.join(meta, on="pool_id", how="inner").join(senders, on="tx_hash", how="inner")
    bt = pl.read_parquet(root / "out" / "block_times.parquet").sort("block")
    bn = bt["block"].to_numpy().astype(np.int64)
    bts = bt["ts"].to_numpy().astype(np.int64)
    df = df.with_columns(ts=pl.Series(
        np.interp(df["block"].to_numpy().astype(np.int64), bn, bts).astype(np.int64)))

    d0 = df["d0"].fill_null(18).to_numpy()
    d1 = df["d1"].fill_null(18).to_numpy()
    rwa0 = df["rwa0"].to_numpy()
    a0 = np.array([float(int(x)) for x in df["amount0"].to_list()])
    a1 = np.array([float(int(x)) for x in df["amount1"].to_list()])
    rwa_delta = -np.where(rwa0, a0 / 10.0 ** d0, a1 / 10.0 ** d1)
    usd_delta = -np.where(rwa0, a1 / 10.0 ** d1, a0 / 10.0 ** d0)
    sp = df["sqrt_price_x96"].cast(pl.Float64).to_numpy()
    p10 = (sp / Q96) ** 2 * (10.0 ** (d0 - d1))
    with np.errstate(divide="ignore", invalid="ignore"):
        px = np.where(rwa0, p10, np.where(p10 > 0, 1.0 / p10, np.nan))
    ok = np.isfinite(px) & (px > 0.01) & (px < 1e5)
    df = df.with_columns(rwa_delta=pl.Series(rwa_delta), usd_delta=pl.Series(usd_delta),
                         ok=pl.Series(ok))

    # Legs are not trades: net each transaction to one position change per token first.
    net = (df.filter(pl.col("ok"))
           .group_by(["tx_hash", "tx_from", "ticker"])
           .agg(pl.col("rwa_delta").sum(), pl.col("usd_delta").sum(), pl.col("ts").min())
           .filter(pl.col("rwa_delta").abs() > DUST)
           .sort("ts"))
    span = (float(net["ts"].max()) - float(net["ts"].min())) / 3600
    return net, span


def match_round_trips(net: pl.DataFrame):
    """FIFO-match sells against on-DEX buys. Returns per-address totals."""
    books: dict[tuple, deque] = defaultdict(deque)     # (addr, ticker) -> [qty, cost/unit]
    matched_qty = defaultdict(float)
    matched_volume = defaultdict(float)                # both legs of matched quantity
    realized = defaultdict(float)
    total_volume = defaultdict(float)
    unmatched_sell_volume = defaultdict(float)

    for addr, tick, dq, dusd, _ts in zip(net["tx_from"], net["ticker"],
                                         net["rwa_delta"].to_numpy(),
                                         net["usd_delta"].to_numpy(), net["ts"].to_numpy()):
        notional = abs(dusd)
        total_volume[addr] += notional
        key = (addr, tick)
        if dq > 0:
            price = notional / dq if dq > DUST else 0.0
            books[key].append([dq, price])
        else:
            want = -dq
            price = notional / want if want > DUST else 0.0
            while want > DUST and books[key]:
                lot = books[key][0]
                take = min(lot[0], want)
                realized[addr] += take * (price - lot[1])
                matched_qty[addr] += take
                matched_volume[addr] += take * price + take * lot[1]
                lot[0] -= take
                want -= take
                if lot[0] <= DUST:
                    books[key].popleft()
            if want > DUST:
                # Sold more than it ever bought here. Out of scope by definition.
                unmatched_sell_volume[addr] += want * price
    return matched_qty, matched_volume, realized, total_volume, unmatched_sell_volume


def report(net: pl.DataFrame, span_hours: float) -> None:
    print("=" * 76)
    print("ROUND-TRIP QUALIFICATION  (buy and sell both on-DEX, FIFO matched)")
    print("=" * 76)
    print(f"  window: {span_hours:.1f} hours of tape, {len(net):,} position changes")
    print(f"\n  {'window':>9} {'addresses':>11} {'qualify':>9} {'% of them':>10} "
          f"{'their volume':>14} {'% of volume':>12}")
    end = float(net["ts"].max())
    for hours in [h for h in (2, 4, 8, 12, 16, 24, 36, span_hours) if h <= span_hours + 0.01]:
        w = net.filter(pl.col("ts") >= end - hours * 3600)
        m_qty, m_vol, _real, tot_vol, _un = match_round_trips(w)
        addrs = set(tot_vol)
        qual = {a for a in addrs if m_qty[a] > DUST}
        total = sum(tot_vol.values())
        qual_vol = sum(tot_vol[a] for a in qual)
        print(f"  {hours:8.1f}h {len(addrs):>11,} {len(qual):>9,} "
              f"{len(qual) / max(len(addrs), 1) * 100:>9.1f}% "
              f"${qual_vol:>13,.0f} {qual_vol / max(total, 1) * 100:>11.1f}%")

    m_qty, m_vol, real, tot_vol, unmatched = match_round_trips(net)
    qual = {a for a in tot_vol if m_qty[a] > DUST}
    total = sum(tot_vol.values())
    print(f"\n  at the full window:")
    print(f"    addresses seen                 {len(tot_vol):>12,}")
    print(f"    qualifying on a round trip     {len(qual):>12,}  "
          f"({len(qual) / max(len(tot_vol), 1) * 100:.1f}%)")
    print(f"    their share of all volume      {sum(tot_vol[a] for a in qual) / max(total, 1) * 100:>11.1f}%")
    print(f"    volume that IS matched flow    "
          f"{sum(m_vol.values()) / max(total, 1) * 100:>11.1f}%  (both legs of matched quantity)")
    print(f"    volume sold with no on-DEX buy "
          f"{sum(unmatched.values()) / max(total, 1) * 100:>11.1f}%  (out of scope by definition)")

    ranked = sorted(qual, key=lambda a: -real[a])
    print(f"\n  top 10 by realized PnL on matched quantity:")
    print(f"    {'#':>3} {'address':<16}{'realized':>14}{'matched vol':>14}{'total vol':>14}")
    for i, a in enumerate(ranked[:10], 1):
        print(f"    {i:>3} {a[:14]:<16}${real[a]:>13,.0f}${m_vol[a]:>13,.0f}${tot_vol[a]:>13,.0f}")


def main() -> int:
    import os
    import sys
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="public", choices=["public", "edge"])
    args = ap.parse_args()
    sys.path.insert(0, str(HERE.parent / "export"))
    from upstream import lp_terminal  # noqa: PLC0415
    net, span = load(lp_terminal(), args.source)
    report(net, span)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
