"""What the combined RWA + Pons ranking actually looks like, before it is built.

One ranking, both universes, everything in USD. ETH-quoted legs convert at the trade's own
timestamp from the chain's ETH/USD series, never at a closing rate.

This is a read-only preview: it writes nothing to web/. The question it answers is how much
of the top of a combined table is Pons and how much is RWA, because that decides whether
the page leads with a distribution or with a number.
"""

from __future__ import annotations

import sys
from collections import defaultdict, deque
from pathlib import Path

import numpy as np
import polars as pl

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "ingest"))
DUST = 1e-12
WINDOW_H = 168


def rwa_trades(root: Path) -> pl.DataFrame:
    from build_leaderboard import load, netted  # noqa: PLC0415
    t = netted(load(root, "edge"))
    return t.select(
        addr=pl.col("tx_from"), book=pl.col("ticker"), label=pl.col("ticker"),
        qty=pl.col("qty"), usd=pl.col("quote_delta"), ts=pl.col("ts"),
        cat=pl.lit("rwa"), quote=pl.lit("USDG"))


def pons_trades(root: Path) -> pl.DataFrame:
    from pons_probe import PONS_FROM, PONS_SWAPS, eth_usd_series, pool_universe  # noqa: PLC0415
    universe = pool_universe(root)
    swaps = pl.concat([pl.read_parquet(p) for p in PONS_SWAPS.glob("part-*.parquet")])
    senders = pl.concat([pl.read_parquet(p) for p in sorted(PONS_FROM.glob("part-*.parquet"))]
                        ).unique(subset=["tx_hash"])
    df = swaps.join(senders, on="tx_hash", how="inner")
    bt = pl.read_parquet(root / "out" / "block_times.parquet").sort("block")
    ts = np.interp(df["block"].to_numpy().astype(np.int64),
                   bt["block"].to_numpy().astype(np.int64),
                   bt["ts"].to_numpy().astype(np.int64)).astype(np.int64)
    a0 = np.array([float(int(x)) for x in df["amount0"].to_list()])
    a1 = np.array([float(int(x)) for x in df["amount1"].to_list()])
    side = np.array([universe[p]["quote_side"] for p in df["pool_id"].to_list()])
    qdec = np.array([universe[p]["qdec"] for p in df["pool_id"].to_list()])
    quote = np.array([universe[p]["quote"] for p in df["pool_id"].to_list()])
    base = -np.where(side == 0, a1, a0)
    q = -np.where(side == 0, a0, a1) / (10.0 ** qdec)
    eth_ts, eth_px = eth_usd_series()
    usd = q * np.where(quote == "ETH", np.interp(ts, eth_ts, eth_px), 1.0)
    net = (pl.DataFrame({"tx": df["tx_hash"], "addr": df["tx_from"], "book": df["pool_id"],
                         "quote": quote, "qty": base, "usd": usd, "ts": ts})
           .group_by(["tx", "addr", "book", "quote"])
           .agg(pl.col("qty").sum(), pl.col("usd").sum(), pl.col("ts").min())
           .filter(pl.col("qty").abs() > DUST))
    return net.select(addr="addr", book="book", label=pl.col("book").str.slice(0, 10),
                      qty="qty", usd="usd", ts="ts", cat=pl.lit("pons"), quote="quote")


def fold(trades: pl.DataFrame):
    """FIFO per (address, book). Books never cross a universe: they are different tokens."""
    books = defaultdict(deque)
    st = defaultdict(lambda: {"realized": 0.0, "matched": 0.0, "total": 0.0, "trips": 0,
                              "wins": 0, "unmatched": 0.0, "cats": set(), "quotes": set()})
    for addr, book, qty, usd, ts, cat, quote in zip(
            trades["addr"], trades["book"], trades["qty"].to_numpy(),
            trades["usd"].to_numpy(), trades["ts"].to_numpy(), trades["cat"], trades["quote"]):
        notional = abs(usd)
        s = st[addr]
        s["total"] += notional
        s["cats"].add(cat)
        s["quotes"].add(quote)
        key = (addr, cat, book)
        if qty > 0:
            books[key].append([qty, notional / qty if qty > DUST else 0.0])
            continue
        want = -qty
        price = notional / want if want > DUST else 0.0
        while want > DUST and books[key]:
            lot = books[key][0]
            take = min(lot[0], want)
            pnl = take * (price - lot[1])
            s["realized"] += pnl
            s["matched"] += take * price + take * lot[1]
            s["trips"] += 1
            s["wins"] += pnl > 0
            lot[0] -= take
            want -= take
            if lot[0] <= DUST:
                books[key].popleft()
        if want > DUST:
            s["unmatched"] += want * price
    return st


def main() -> int:
    from upstream import lp_terminal  # noqa: PLC0415
    root = lp_terminal()
    a, b = rwa_trades(root), pons_trades(root)
    both = pl.concat([a, b], how="vertical_relaxed").sort("ts")
    hi = int(both["ts"].max())
    both = both.filter(pl.col("ts") >= hi - WINDOW_H * 3600)
    print(f"RWA {a.height:,} position changes, Pons {b.height:,}, combined {both.height:,}")

    st = fold(both)
    rows = [{"addr": k, **{x: v[x] for x in ("realized", "matched", "total", "trips",
                                             "wins", "unmatched")},
             "cat": "both" if len(v["cats"]) > 1 else next(iter(v["cats"])),
             "quotes": "+".join(sorted(v["quotes"]))}
            for k, v in st.items()]
    df = pl.DataFrame(rows)
    qual = df.filter(pl.col("trips") > 0).sort("realized", descending=True)
    print(f"\nUNIVERSE  {df.height:,} addresses traded, {qual.height:,} closed a round-trip "
          f"({qual.height/df.height*100:.1f}%)")
    for c in ("rwa", "pons", "both"):
        s = df.filter(pl.col("cat") == c)
        q = qual.filter(pl.col("cat") == c)
        print(f"  {c:<5} {s.height:>7,} traded  {q.height:>7,} qualify")

    for n in (10, 100, 1000):
        top = qual.head(n)
        c = top["cat"].value_counts().sort("count", descending=True)
        parts = ", ".join(f"{r['cat']} {r['count']} ({r['count']/n*100:.0f}%)"
                          for r in c.iter_rows(named=True))
        print(f"\nTOP {n}: {parts}")
        print(f"   realized: max ${top['realized'].max():,.0f}  "
              f"median ${top['realized'].median():,.0f}  min ${top['realized'].min():,.0f}")
    r = qual["realized"].to_numpy()
    print(f"\nDISTRIBUTION over {len(r):,} qualifying addresses")
    for p in (100, 99.9, 99, 95, 75, 50, 25, 5, 1, 0):
        print(f"   p{p:<5} ${np.percentile(r, p):>14,.2f}")
    print(f"   in profit: {(r > 0).sum():,} ({(r > 0).mean():.1%})   "
          f"at a loss: {(r < 0).sum():,} ({(r < 0).mean():.1%})")
    print(f"   total won ${r[r > 0].sum():,.0f}   total lost ${r[r < 0].sum():,.0f}")
    top1 = np.sort(r)[::-1][:max(len(r)//100, 1)]
    print(f"   top 1% take ${top1.sum():,.0f} of ${r[r > 0].sum():,.0f} won "
          f"({top1.sum()/r[r > 0].sum():.1%})")
    cov = 1 - qual["unmatched"].to_numpy() / np.maximum(qual["total"].to_numpy(), 1e-9)
    print(f"   coverage: median {np.median(cov)*100:.1f}% of flow has an on-chain buy")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


def scoped(both: pl.DataFrame, name: str, pred) -> None:
    """A filter has to rescope the PnL, not just hide rows.

    68 of the top 100 trade BOTH universes, so filtering the address list would leave a
    "Pons" tab whose numbers still contained RWA profit. Each scope is folded on its own
    trades.
    """
    sub = both.filter(pred)
    if not sub.height:
        return print(f"  {name:<14} no trades")
    st = fold(sub)
    r = np.array([v["realized"] for v in st.values() if v["trips"] > 0])
    q = len(r)
    print(f"  {name:<14} {len(st):>7,} traded  {q:>7,} qualify   "
          f"top ${r.max():>12,.0f}   p50 ${np.median(r):>9,.2f}   "
          f"in profit {(r > 0).mean():>5.1%}")


def scopes() -> int:
    from upstream import lp_terminal  # noqa: PLC0415
    root = lp_terminal()
    a, b = rwa_trades(root), pons_trades(root)
    both = pl.concat([a, b], how="vertical_relaxed").sort("ts")
    hi = int(both["ts"].max())
    both = both.filter(pl.col("ts") >= hi - WINDOW_H * 3600)
    print("WHAT EACH TAB WOULD SHOW (PnL refolded per scope, not filtered rows)")
    scoped(both, "All", pl.lit(True))
    scoped(both, "RWA", pl.col("cat") == "rwa")
    scoped(both, "Pons", pl.col("cat") == "pons")
    scoped(both, "quote USDG", pl.col("quote") == "USDG")
    scoped(both, "quote ETH", pl.col("quote") == "ETH")
    scoped(both, "Pons/USDG", (pl.col("cat") == "pons") & (pl.col("quote") == "USDG"))
    scoped(both, "Pons/ETH", (pl.col("cat") == "pons") & (pl.col("quote") == "ETH"))
    return 0
