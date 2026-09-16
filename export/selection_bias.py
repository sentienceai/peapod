"""Is the win-rate badge measuring a favourably selected subset of an address's selling?

THE OBJECTION. The evidence bar tests win rate on matched round-trips. But 72% of selling
on this chain has no on-chain buy behind it, so it is out of scope and invisible to the
test. If an address's off-tape-acquired selling is systematically worse than the part that
round-trips, the badge is scored on the good half and reads high.

The objection cannot be answered directly: an unmatched sell has no cost basis, which is
precisely why it is out of scope. There is no PnL to compare. So it is answered three ways
that do not need one.

  A. CROSS-SECTIONAL. Across addresses, does measured win rate rise with the share of an
     address's flow that goes unmatched? Stratified by round-trip count, because win rate
     is noisier at small n and unmatched share may travel with activity.

  B. WITHIN-ADDRESS EXECUTION. For one address, compare the price of its MATCHED sells
     against its UNMATCHED sells, each measured relative to that token's volume-weighted
     average price on the same UTC day. This needs no cost basis -- it asks whether the
     sells that happen to round-trip are executed better than the ones that do not. Within
     an address, so it cannot be explained by different addresses being different.

  C. THE JOIN. Among addresses with both, is round-trip performance related to how bad
     their unmatched selling looks? That is the question as asked: if the addresses with
     the best badges are the ones whose invisible selling is worst, the badge is selecting.

WHAT A NULL RESULT WOULD MEAN. That the two kinds of selling are executed alike, so the
matched subset is not favourably selected on execution. It would NOT prove the badge is
unbiased on PnL, because basis is still unobservable. That limit is reported, not buried.

Usage:  PEAPOD_LP_TERMINAL=~/lp-terminal uv run python export/selection_bias.py
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict, deque
from pathlib import Path

import numpy as np
import polars as pl

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
DUST = 1e-12
WINDOW_H = 168


def sell_ledger(trades: pl.DataFrame):
    """Replay FIFO, recording every sell split into its matched and unmatched parts."""
    books = defaultdict(deque)
    sells = []
    per = defaultdict(lambda: {"trips": 0, "wins": 0, "realized": 0.0, "matched": 0.0,
                               "total": 0.0, "unmatched": 0.0})
    for addr, tick, qty, quote_delta, ts in zip(
            trades["tx_from"], trades["ticker"], trades["qty"].to_numpy(),
            trades["quote_delta"].to_numpy(), trades["ts"].to_numpy()):
        notional = abs(quote_delta)
        p = per[addr]
        p["total"] += notional
        key = (addr, tick)
        if qty > 0:
            books[key].append([qty, notional / qty if qty > DUST else 0.0, int(ts)])
            continue
        want = -qty
        price = notional / want if want > DUST else 0.0
        matched_qty = 0.0
        while want > DUST and books[key]:
            lot = books[key][0]
            take = min(lot[0], want)
            pnl = take * (price - lot[1])
            p["realized"] += pnl
            p["matched"] += take * price + take * lot[1]
            p["trips"] += 1
            p["wins"] += pnl > 0
            matched_qty += take
            lot[0] -= take
            want -= take
            if lot[0] <= DUST:
                books[key].popleft()
        if want > DUST:
            p["unmatched"] += want * price
        sells.append((addr, tick, int(ts), price, matched_qty, max(want, 0.0)))
    return sells, per


def main() -> int:
    from upstream import lp_terminal  # noqa: PLC0415
    from build_leaderboard import load, netted  # noqa: PLC0415

    root = lp_terminal()
    trades = netted(load(root, "edge"))
    hi = int(trades["ts"].max())
    trades = trades.filter(pl.col("ts") >= hi - WINDOW_H * 3600).sort("ts")
    sells, per = sell_ledger(trades)
    print(f"{len(trades):,} position changes, {len(sells):,} sells, {len(per):,} addresses")

    # The day's volume-weighted average price per token, from every trade in it. A sell is
    # then "above" or "below" the day, which is a measure of execution that needs no basis.
    day = (trades.with_columns(day=(pl.col("ts") // 86400))
           .with_columns(notional=pl.col("quote_delta").abs(), q=pl.col("qty").abs())
           .group_by(["ticker", "day"])
           .agg(pl.col("notional").sum(), pl.col("q").sum()))
    vwap = {(t, d): n / q for t, d, n, q in
            zip(day["ticker"], day["day"], day["notional"], day["q"]) if q > DUST}

    rel_m = defaultdict(list)   # address -> [(relative price, weight)] for matched sells
    rel_u = defaultdict(list)
    for addr, tick, ts, price, mq, uq in sells:
        v = vwap.get((tick, ts // 86400))
        if not v or price <= 0:
            continue
        r = price / v
        if mq > DUST:
            rel_m[addr].append((r, mq))
        if uq > DUST:
            rel_u[addr].append((r, uq))

    def wmean(pairs):
        w = sum(x[1] for x in pairs)
        return sum(r * q for r, q in pairs) / w if w > 0 else None

    rows = []
    for addr, p in per.items():
        if p["trips"] < 1 or p["total"] <= 0:
            continue
        m, u = wmean(rel_m.get(addr, [])), wmean(rel_u.get(addr, []))
        rows.append({"addr": addr, "trips": p["trips"],
                     "win_rate": p["wins"] / p["trips"] * 100,
                     "realized": p["realized"],
                     "ret": p["realized"] / p["matched"] * 100 if p["matched"] > 0 else 0.0,
                     "unmatched_share": p["unmatched"] / p["total"] * 100,
                     "rel_matched": m, "rel_unmatched": u,
                     "delta": (m - u) if (m is not None and u is not None) else None})
    df = pl.DataFrame(rows)
    print(f"{df.height:,} addresses with at least one round-trip")

    def spearman(a, b):
        ra = np.argsort(np.argsort(a)).astype(float)
        rb = np.argsort(np.argsort(b)).astype(float)
        return float(np.corrcoef(ra, rb)[0, 1])

    print("\n" + "=" * 74)
    print("A. DOES MEASURED WIN RATE RISE WITH THE SHARE THAT GOES UNMATCHED?")
    print("=" * 74)
    for lo_n, hi_n in ((1, 4), (5, 19), (20, 99), (100, 10 ** 9)):
        s = df.filter((pl.col("trips") >= lo_n) & (pl.col("trips") <= hi_n))
        if s.height < 40:
            continue
        us = s["unmatched_share"].to_numpy()
        wr = s["win_rate"].to_numpy()
        qs = np.percentile(us, [25, 50, 75])
        bands = [("none   ", us <= 1e-9), ("low    ", (us > 1e-9) & (us <= qs[1])),
                 ("high   ", us > qs[1])]
        label = f"{lo_n}-{hi_n if hi_n < 10**9 else '+'} round-trips"
        print(f"\n  {label} (n={s.height:,})   rho(unmatched share, win rate) = "
              f"{spearman(us, wr):+.3f}")
        for name, mask in bands:
            if mask.sum() < 10:
                continue
            print(f"    unmatched {name} n={int(mask.sum()):>6,}  "
                  f"median win rate {np.median(wr[mask]):>5.1f}%  "
                  f"median unmatched share {np.median(us[mask]):>5.1f}%")

    both = df.filter(pl.col("delta").is_not_null())
    print("\n" + "=" * 74)
    print("B. WITHIN AN ADDRESS, DO THE SELLS THAT ROUND-TRIP EXECUTE BETTER?")
    print("=" * 74)
    d = both["delta"].to_numpy()
    print(f"  {both.height:,} addresses have both matched and unmatched sells")
    print(f"  matched sells vs their own unmatched sells, relative to the token's day VWAP:")
    print(f"    median difference {np.median(d) * 100:+.3f}%   mean {d.mean() * 100:+.3f}%")
    print(f"    addresses where matched executed better: {(d > 0).mean():.1%} "
          f"(a coin flip would be 50%)")
    se = d.std(ddof=1) / np.sqrt(len(d))
    print(f"    95% interval on the mean: "
          f"{(d.mean() - 1.96 * se) * 100:+.3f}% .. {(d.mean() + 1.96 * se) * 100:+.3f}%")

    print("\n" + "=" * 74)
    print("C. ARE THE BEST BADGES THE ONES WITH THE WORST INVISIBLE SELLING?")
    print("=" * 74)
    bd = both.filter(pl.col("trips") >= 5)
    if bd.height >= 40:
        ru = bd["rel_unmatched"].to_numpy()
        print(f"  {bd.height:,} addresses with 5+ round-trips and unmatched sells")
        print(f"    rho(win rate, execution of their unmatched selling) = "
              f"{spearman(bd['win_rate'].to_numpy(), ru):+.3f}")
        print(f"    rho(return on matched volume, same)                 = "
              f"{spearman(bd['ret'].to_numpy(), ru):+.3f}")
        top = bd.sort("win_rate", descending=True).head(max(bd.height // 10, 10))
        rest = bd.sort("win_rate", descending=True).tail(bd.height - top.height)
        print(f"    top decile by win rate:   unmatched sells at "
              f"{np.median(top['rel_unmatched'].to_numpy()):.4f}x the day VWAP")
        print(f"    everyone else:            unmatched sells at "
              f"{np.median(rest['rel_unmatched'].to_numpy()):.4f}x")
    out = HERE.parent / "out" / "selection-bias.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps({
        "addresses": df.height, "with_both": both.height,
        "delta_median_pct": float(np.median(d) * 100),
        "delta_mean_pct": float(d.mean() * 100),
        "share_matched_better": float((d > 0).mean()),
    }, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
