"""The three feasibility questions, at EOA level.

Identity is `tx.from` — the account that signed and paid for the transaction — not the
`sender` on the Swap log, which is whatever contract called PoolManager.

LEGS ARE NOT TRADES. A routed swap can touch several pools inside one transaction; a
three-hop route is one decision, not three. Every transaction is therefore netted to a
single position change per token before anything is counted: deltas are summed within
(transaction, token), and an intermediate token that was bought and sold in the same
transaction nets to zero and disappears, which is what actually happened. Volume is
counted once per transaction, not once per leg.

COVERAGE IS CHECKED, NOT ASSUMED. Resolution runs newest-first, so at any moment some
recent window is complete and everything older is partial. A window that is only partly
resolved cannot answer question 3 at all: an address whose earlier trades are missing looks
like one that acquired tokens off-tape. So each window reports the share of its swaps with a
resolved payer, and anything under the threshold is reported as incomplete rather than
quietly averaged in.

Usage:  uv run python ingest/feasibility.py [--days N ...]
"""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path

import numpy as np
import polars as pl

HERE = Path(__file__).resolve().parent
Q96 = 1 << 96
DUST_UNITS = 1e-6          # token units below which a negative balance is float noise
DUST_USD = 1.0             # dollars below which a short position is not worth flagging


def load(root: Path, source: str = "public") -> pl.DataFrame:
    swaps = pl.concat([pl.read_parquet(p) for p in sorted((HERE / "out" / "swaps_tx").glob("part-*.parquet"))])
    # The RPC returns blockTimestamp as 0x0 on every log, so times come from the block
    # index rather than the log, as they did before the re-ingest.
    bt = pl.read_parquet(root / "out" / "block_times.parquet").sort("block")
    blocks = bt["block"].to_numpy().astype(np.int64)
    times = bt["ts"].to_numpy().astype(np.int64)
    swaps = swaps.with_columns(ts=pl.Series(
        np.interp(swaps["block"].to_numpy().astype(np.int64), blocks, times).astype(np.int64)))
    suffix = "" if source == "public" else f"_{source}"
    parts = sorted((HERE / "out" / f"tx_from{suffix}").glob("part-*.parquet"))
    if not parts:
        raise SystemExit("no resolved transactions; run ingest/resolve_senders.py first")
    senders = pl.concat([pl.read_parquet(p) for p in parts]).unique(subset=["tx_hash"])

    pools = pl.concat([pl.read_parquet(p) for p in sorted((root / "out" / "raw" / "pools").glob("part-*.parquet"))])
    tok = pl.read_parquet(root / "out" / "raw" / "tokens" / "part-00000.parquet")
    t0 = tok.select(pl.col("address").alias("currency0"), pl.col("symbol").alias("s0"),
                    pl.col("decimals").alias("d0"), pl.col("kind").alias("k0"))
    t1 = tok.select(pl.col("address").alias("currency1"), pl.col("symbol").alias("s1"),
                    pl.col("decimals").alias("d1"), pl.col("kind").alias("k1"))
    meta = (pools.join(t0, on="currency0", how="left").join(t1, on="currency1", how="left")
            .with_columns(rwa0=(pl.col("k0") == "rwa_spot"),
                          ticker=pl.when(pl.col("k0") == "rwa_spot").then(pl.col("s0")).otherwise(pl.col("s1")))
            .select("pool_id", "ticker", "rwa0", "d0", "d1"))

    df = swaps.join(meta, on="pool_id", how="inner").join(senders, on="tx_hash", how="left")
    return df.sort(["block", "log_index"])


def derive(df: pl.DataFrame) -> pl.DataFrame:
    d0 = df["d0"].fill_null(18).to_numpy()
    d1 = df["d1"].fill_null(18).to_numpy()
    rwa0 = df["rwa0"].to_numpy()
    a0 = np.array([float(int(x)) for x in df["amount0"].to_list()])
    a1 = np.array([float(int(x)) for x in df["amount1"].to_list()])
    # The trader's delta is the negative of the pool's.
    rwa_delta = -np.where(rwa0, a0 / 10.0 ** d0, a1 / 10.0 ** d1)
    usd_delta = -np.where(rwa0, a1 / 10.0 ** d1, a0 / 10.0 ** d0)
    sp = df["sqrt_price_x96"].cast(pl.Float64).to_numpy()
    p10 = (sp / Q96) ** 2 * (10.0 ** (d0 - d1))
    with np.errstate(divide="ignore", invalid="ignore"):
        px = np.where(rwa0, p10, np.where(p10 > 0, 1.0 / p10, np.nan))
    ok = np.isfinite(px) & (px > 0.01) & (px < 1e5)
    return df.with_columns(rwa_delta=pl.Series(rwa_delta), usd_delta=pl.Series(usd_delta),
                           px=pl.Series(px), ok=pl.Series(ok))


def net_transactions(df: pl.DataFrame) -> pl.DataFrame:
    """One row per (transaction, token): legs inside a transaction are summed, not counted.

    An intermediate token bought and sold in the same transaction nets to zero and is
    dropped, because the trader never held a position in it.
    """
    netted = (df.filter(pl.col("ok") & pl.col("tx_from").is_not_null())
              .group_by(["tx_hash", "tx_from", "ticker"])
              .agg(pl.col("rwa_delta").sum(), pl.col("usd_delta").sum(),
                   pl.col("block").min(), pl.col("ts").min().alias("ts"),
                   pl.len().alias("legs"), pl.col("pool_id").n_unique().alias("pools"),
                   pl.col("sender").n_unique().alias("routers"))
              .sort(["block", "tx_hash"]))
    return netted.filter(pl.col("rwa_delta").abs() > DUST_UNITS)


def report(df: pl.DataFrame, netted: pl.DataFrame) -> None:
    total_swaps = len(df)
    resolved = df.filter(pl.col("tx_from").is_not_null())
    print("=" * 78)
    print("ATTRIBUTION")
    print("=" * 78)
    print(f"  swap legs on tape          {total_swaps:,}")
    print(f"  legs with a resolved payer {len(resolved):,} ({len(resolved) / total_swaps * 100:.2f}%)")
    print(f"  distinct transactions      {df['tx_hash'].n_unique():,}")
    print(f"  distinct log senders       {df['sender'].n_unique():,}")
    print(f"  distinct payers (tx.from)  {resolved['tx_from'].n_unique():,}")
    routed = resolved.filter(pl.col("sender") != pl.col("tx_from"))
    print(f"  legs where sender != payer {len(routed):,} ({len(routed) / max(len(resolved), 1) * 100:.2f}%)")
    print(f"\n  after netting legs to trades: {len(netted):,} position changes "
          f"across {netted['tx_hash'].n_unique():,} transactions")
    multi = netted.filter(pl.col("legs") > 1)
    print(f"  position changes built from more than one leg: {len(multi):,} "
          f"({len(multi) / max(len(netted), 1) * 100:.1f}%)")

    vol = netted.with_columns(notional=pl.col("usd_delta").abs())
    by_eoa = (vol.group_by("tx_from")
              .agg(pl.col("notional").sum().alias("volume"),
                   pl.col("tx_hash").n_unique().alias("trades"),
                   pl.col("ticker").n_unique().alias("tickers"),
                   pl.col("ts").min().alias("first"), pl.col("ts").max().alias("last"))
              .sort("volume", descending=True))
    total = by_eoa["volume"].sum()

    print("\n" + "=" * 78)
    print("1. HOW MANY ADDRESSES CAN BE RANKED")
    print("=" * 78)
    print(f"  distinct paying accounts: {len(by_eoa):,}   total netted volume ${total:,.0f}")
    active_days = (by_eoa["last"] - by_eoa["first"]) / 86400
    for n in (1, 5, 10, 25, 50, 100):
        mask = (by_eoa["trades"] >= n) & (active_days >= 2)
        share = by_eoa.filter(pl.Series(mask))["volume"].sum() / total * 100 if total else 0
        print(f"    >= {n:>3} trades and >= 2 days active: {mask.sum():>7,}  ({share:5.1f}% of volume)")

    print("\n" + "=" * 78)
    print("2. ROUTER SHARE, NOW THAT ATTRIBUTION IS CORRECT")
    print("=" * 78)
    cum = np.cumsum(by_eoa["volume"].to_numpy()) / total * 100
    for n in (1, 3, 5, 10, 25, 100, 1000):
        if n <= len(cum):
            print(f"    top {n:>5} accounts: {cum[n - 1]:6.2f}% of volume")
    router_rows = resolved.filter(pl.col("sender") != pl.col("tx_from"))
    by_router = (router_rows.group_by("sender").agg(pl.len().alias("legs"))
                 .sort("legs", descending=True))
    print(f"\n    contracts appearing as log sender: {by_router.height:,}")
    for r in by_router.head(5).iter_rows(named=True):
        users = router_rows.filter(pl.col("sender") == r["sender"])["tx_from"].n_unique()
        print(f"      {r['sender'][:14]}  legs {r['legs']:>8,}  distinct payers behind it {users:>7,}")

    print("\n" + "=" * 78)
    print("3. TOKENS HELD THAT WERE NOT ACQUIRED ON TAPE")
    print("=" * 78)
    balance = defaultdict(float)
    lowest = defaultdict(float)
    for who, tick, delta in zip(netted["tx_from"].to_list(), netted["ticker"].to_list(),
                                netted["rwa_delta"].to_numpy()):
        key = (who, tick)
        balance[key] += delta
        if balance[key] < lowest[key]:
            lowest[key] = balance[key]
    px_last = (netted.group_by("ticker").agg(pl.col("usd_delta").abs().sum().alias("v"),
                                             pl.col("rwa_delta").abs().sum().alias("q")))
    price = {r["ticker"]: (r["v"] / r["q"] if r["q"] else 0.0) for r in px_last.iter_rows(named=True)}

    short_tokens = defaultdict(int)
    short_usd = defaultdict(float)
    for (who, tick), low in lowest.items():
        if low < -DUST_UNITS and abs(low) * price.get(tick, 0.0) > DUST_USD:
            short_tokens[who] += 1
            short_usd[who] += abs(low) * price.get(tick, 0.0)

    for n in (100, 500):
        top = by_eoa.head(n)["tx_from"].to_list()
        flagged = [a for a in top if short_tokens[a] > 0]
        print(f"    of the top {n:>3} accounts by volume: {len(flagged)} "
              f"({len(flagged) / max(len(top), 1) * 100:.0f}%) sold a token they never bought here")
    allf = sum(1 for a in by_eoa["tx_from"].to_list() if short_tokens[a] > 0)
    print(f"    across all {len(by_eoa):,} accounts: {allf:,} ({allf / max(len(by_eoa), 1) * 100:.1f}%)")

    ranked = by_eoa.filter((by_eoa["trades"] >= 5) & (active_days >= 2))
    rf = [a for a in ranked["tx_from"].to_list() if short_tokens[a] > 0]
    print(f"    among the {len(ranked):,} rankable accounts: {len(rf):,} "
          f"({len(rf) / max(len(ranked), 1) * 100:.1f}%) would need excluding or flagging")

    print("\n    top 12 accounts by netted volume:")
    print(f"      {'#':>3} {'account':<16}{'volume':>14}{'trades':>9}{'tokens':>8}{'short in':>10}")
    for i, r in enumerate(by_eoa.head(12).iter_rows(named=True), 1):
        print(f"      {i:>3} {r['tx_from'][:14]:<16}${r['volume']:>13,.0f}{r['trades']:>9,}"
              f"{r['tickers']:>8}{short_tokens[r['tx_from']]:>10}")


COVERAGE_FLOOR = 0.999


def window(df: pl.DataFrame, days: float) -> tuple[pl.DataFrame, float]:
    """The last `days` of tape, and the share of its swaps with a resolved payer."""
    cutoff = int(df["ts"].max()) - int(days * 86400)
    w = df.filter(pl.col("ts") >= cutoff)
    if len(w) == 0:
        return w, 0.0
    return w, w.filter(pl.col("tx_from").is_not_null()).height / len(w)


def coverage_table(df: pl.DataFrame, day_list) -> None:
    print("=" * 78)
    print("RESOLUTION COVERAGE  (newest-first; a partial window cannot answer question 3)")
    print("=" * 78)
    for days in day_list:
        w, cov = window(df, days)
        flag = "complete" if cov >= COVERAGE_FLOOR else "INCOMPLETE — do not report"
        print(f"  last {days:>4}d: {len(w):>9,} swap legs, payer resolved for "
              f"{cov * 100:6.2f}%   {flag}")
    _, total_cov = window(df, 1e9)
    print(f"  whole tape: {len(df):>9,} swap legs, payer resolved for {total_cov * 100:6.2f}%")


def main() -> int:
    import argparse
    import sys
    sys.path.insert(0, str(HERE.parent / "export"))
    from upstream import lp_terminal  # noqa: PLC0415

    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=float, nargs="*", default=[1, 3, 7],
                    help="windows to check for the convergence report")
    ap.add_argument("--source", default="public")
    ap.add_argument("--report", type=float, default=None,
                    help="run the full three-question report on this window")
    args = ap.parse_args()

    df = derive(load(lp_terminal(), args.source))
    coverage_table(df, args.days)

    if args.report is not None:
        w, cov = window(df, args.report)
        print(f"\nreporting on the last {args.report} days "
              f"({cov * 100:.2f}% of its legs have a resolved payer)")
        if cov < COVERAGE_FLOOR:
            print("  refusing: this window is not fully resolved, so any count of addresses")
            print("  holding tokens they did not buy here would be an artefact of the gap.")
            return 1
        report(w, net_transactions(w))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
