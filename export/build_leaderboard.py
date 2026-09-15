"""Build the leaderboard partitions the site reads.

REALIZED, ROUND-TRIPS ONLY. An address enters on a token it bought on-chain and later sold
on-chain, matched first-in-first-out, and PnL is computed on the matched quantity alone.
Units that arrived any other way are out of scope, not flagged and included at a guessed
cost basis. This ranks trading, not holdings.

FIFO IS STATEFUL ACROSS DAYS, so days are a sequential fold: each day reads the previous
day's open lots, applies its own trades, and emits both its realized rows and its own
closing lots. A day cannot be computed in isolation and this does not pretend otherwise.

Usage:  PEAPOD_LP_TERMINAL=~/lp-terminal PYTHONPATH=ingest:export \
          uv run python export/build_leaderboard.py [--source edge]
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
from collections import defaultdict, deque
from pathlib import Path

import numpy as np
import polars as pl

HERE = Path(__file__).resolve().parent
INGEST = HERE.parent / "ingest" / "out"
OUT = HERE.parent / "web" / "data" / "leaderboard"
Q96 = 1 << 96
DUST = 1e-12
SPARK_POINTS = 24


def load(root: Path, source: str) -> pl.DataFrame:
    suffix = "" if source == "public" else f"_{source}"
    swaps = pl.concat([pl.read_parquet(p)
                       for p in sorted((INGEST / "swaps_tx").glob("part-*.parquet"))])
    parts = sorted((INGEST / f"tx_from{suffix}").glob("part-*.parquet"))
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
                                   .then(pl.col("s0")).otherwise(pl.col("s1")),
                          quote=pl.when(pl.col("k0") == "rwa_spot")
                                  .then(pl.col("s1")).otherwise(pl.col("s0")))
            .select("pool_id", "ticker", "quote", "rwa0", "d0", "d1"))
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
    qty = -np.where(rwa0, a0 / 10.0 ** d0, a1 / 10.0 ** d1)
    quote = -np.where(rwa0, a1 / 10.0 ** d1, a0 / 10.0 ** d0)
    sp = df["sqrt_price_x96"].cast(pl.Float64).to_numpy()
    p10 = (sp / Q96) ** 2 * (10.0 ** (d0 - d1))
    with np.errstate(divide="ignore", invalid="ignore"):
        px = np.where(rwa0, p10, np.where(p10 > 0, 1.0 / p10, np.nan))
    ok = np.isfinite(px) & (px > 0.01) & (px < 1e5)
    return df.with_columns(qty=pl.Series(qty), quote=pl.Series(quote), ok=pl.Series(ok))


def netted(df: pl.DataFrame) -> pl.DataFrame:
    """Legs are not trades: one position change per (transaction, token)."""
    return (df.filter(pl.col("ok"))
            .group_by(["tx_hash", "tx_from", "ticker", "quote"])
            .agg(pl.col("qty").sum(), pl.col("quote").sum().alias("quote_delta"),
                 pl.col("ts").min())
            .filter(pl.col("qty").abs() > DUST)
            .sort("ts"))


# Label criteria, published with the label. Each is a measurable property of the trade
# record, not a judgement about the trader. There is deliberately no "smart money" label:
# every definition of it reduces to "made money recently", which is the ranking itself.
LABELS = [
    {"id": "one-shot", "label": "One-shot",
     "criteria": "Exactly one completed round-trip in this window."},
    {"id": "arbitrageur", "label": "Arbitrageur",
     "criteria": "At least 5 round-trips closed within 2 seconds of opening — inside a "
                 "block or two of the buy."},
    {"id": "bot", "label": "Bot",
     "criteria": "At least 50 round-trips and a median hold under 60 seconds."},
    {"id": "market-maker", "label": "Market maker",
     "criteria": "At least 100 position changes, buys and sells within 20% of each other "
                 "in count, and a median hold under 5 minutes."},
]


def classify(stats: dict) -> list[str]:
    """Which labels a record earns. Criteria are published beside the label in the UI."""
    out = []
    if stats["round_trips"] == 1:
        out.append("one-shot")
    if stats["fast_trips"] >= 5:
        out.append("arbitrageur")
    if stats["round_trips"] >= 50 and stats["median_hold"] < 60:
        out.append("bot")
    buys, sells = stats["buys"], stats["sells"]
    balanced = buys and sells and 0.8 <= buys / sells <= 1.25
    if stats["changes"] >= 100 and balanced and stats["median_hold"] < 300:
        out.append("market-maker")
    return out


def style_of(median_hold: float) -> str:
    """Trading style, derived only from median hold. Stated as such in the UI."""
    if median_hold < 60:
        return "Scalp"
    if median_hold < 3600:
        return "Intraday"
    if median_hold < 86400:
        return "Day"
    return "Swing"


def fold(trades: pl.DataFrame):
    """Walk trades in time order, matching FIFO. Yields per-address running state."""
    books = defaultdict(deque)
    realized = defaultdict(float)
    matched = defaultdict(float)
    total = defaultdict(float)
    wins = defaultdict(int)
    trips = defaultdict(int)
    tokens = defaultdict(set)
    unmatched = defaultdict(float)
    series = defaultdict(list)
    detail = defaultdict(list)     # completed round-trips, for the detail view
    moves = defaultdict(list)      # position changes, for the trades tab
    holds = defaultdict(list)
    buys = defaultdict(int)
    sells = defaultdict(int)
    changes = defaultdict(int)
    first_seen = {}
    last_seen = {}

    for addr, tick, qty, quote_delta, ts in zip(
            trades["tx_from"], trades["ticker"], trades["qty"].to_numpy(),
            trades["quote_delta"].to_numpy(), trades["ts"].to_numpy()):
        notional = abs(quote_delta)
        total[addr] += notional
        tokens[addr].add(tick)
        changes[addr] += 1
        moves[addr].append({"ts": int(ts), "token": tick, "side": "buy" if qty > 0 else "sell",
                            "qty": abs(float(qty)), "value": notional,
                            "price": notional / abs(float(qty)) if abs(qty) > DUST else 0.0})
        first_seen.setdefault(addr, int(ts))
        last_seen[addr] = int(ts)
        key = (addr, tick)
        if qty > 0:
            buys[addr] += 1
            books[key].append([qty, notional / qty if qty > DUST else 0.0, int(ts)])
        else:
            sells[addr] += 1
            want = -qty
            price = notional / want if want > DUST else 0.0
            while want > DUST and books[key]:
                lot = books[key][0]
                take = min(lot[0], want)
                pnl = take * (price - lot[1])
                realized[addr] += pnl
                matched[addr] += take * price + take * lot[1]
                trips[addr] += 1
                wins[addr] += pnl > 0
                held = int(ts) - lot[2]
                holds[addr].append(held)
                detail[addr].append({"token": tick, "qty": take, "buy": lot[1],
                                     "sell": price, "opened": lot[2], "closed": int(ts),
                                     "held": held, "realized": pnl})
                series[addr].append((int(ts), realized[addr]))
                lot[0] -= take
                want -= take
                if lot[0] <= DUST:
                    books[key].popleft()
            if want > DUST:
                unmatched[addr] += want * price
    return {"realized": realized, "matched": matched, "total": total, "wins": wins,
            "trips": trips, "tokens": tokens, "unmatched": unmatched, "series": series,
            "detail": detail, "holds": holds, "buys": buys, "sells": sells,
            "changes": changes, "first": first_seen, "last": last_seen, "moves": moves}


def spark(points, lo, hi, n=SPARK_POINTS):
    """Cumulative realized resampled to a fixed number of points, for a sparkline."""
    if not points:
        return []
    out, i, last = [], 0, 0.0
    for k in range(n):
        edge = lo + (hi - lo) * (k + 1) / n
        while i < len(points) and points[i][0] <= edge:
            last = points[i][1]
            i += 1
        out.append(round(last, 6))
    return out


# How many ranked rows ship. The full qualifying set is far larger, and the page says so
# rather than presenting a truncation as the whole ranking.
ROW_LIMIT = 1000


def build(state, lo, hi, limit=ROW_LIMIT):
    rows = []
    for addr, trips in state["trips"].items():
        if trips <= 0:
            continue
        rows.append({
            "address": addr,
            "realized": state["realized"][addr],
            "matched_volume": state["matched"][addr],
            "total_volume": state["total"][addr],
            "win_rate": state["wins"][addr] / trips * 100,
            "round_trips": trips,
            "tokens": sorted(state["tokens"][addr])[:4],
            "token_count": len(state["tokens"][addr]),
            "out_of_scope_volume": state["unmatched"][addr],
        })
    rows.sort(key=lambda r: -r["realized"])
    shipped = rows[:limit]
    for i, r in enumerate(shipped, 1):
        r["rank"] = i
        # Sparklines are only drawn on the podium, so only the podium carries the series.
        # Shipping 24 points for every row tripled the file for pixels nothing renders.
        if i <= 3:
            r["spark"] = spark(state["series"][r["address"]], lo, hi)
    return shipped, len(rows)


def daily_breakdown(trips: list[dict]) -> list[dict]:
    """Realized PnL per UTC day, for the performance tab.

    Aggregated here rather than in the browser because the shipped round-trip list is
    capped, and a daily total computed from a truncated list would be quietly wrong.
    """
    by_day = defaultdict(lambda: {"realized": 0.0, "round_trips": 0, "wins": 0})
    for t in trips:
        day = dt.datetime.fromtimestamp(t["closed"], dt.timezone.utc).strftime("%Y-%m-%d")
        e = by_day[day]
        e["realized"] += t["realized"]
        e["round_trips"] += 1
        e["wins"] += t["realized"] > 0
    return [{"day": d, **v, "win_rate": v["wins"] / max(v["round_trips"], 1) * 100}
            for d, v in sorted(by_day.items())]


def longest_streak(trips: list[dict]) -> int:
    best = run = 0
    for t in trips:
        run = run + 1 if t["realized"] > 0 else 0
        best = max(best, run)
    return best


def downsample(series: list, cap: int = 500) -> list:
    """Thin a series to `cap` points, always keeping the first and last.

    A chart cannot render 900 points usefully, and shipping them multiplies the file for
    pixels nobody sees. The endpoints are kept so the total shown never drifts from the
    total computed.
    """
    if len(series) <= cap:
        return series
    step = len(series) / cap
    out = [series[int(i * step)] for i in range(cap - 1)]
    out.append(series[-1])
    return out


def slim_provenance(provenance: dict) -> dict:
    """A stamp, not the whole block.

    Provenance travels with each top-level data file because those get downloaded and
    quoted on their own. At 53,222 per-address files the same block was 90% of the payload
    and 320 MB of the total, so these carry a dated stamp and a pointer to the full record
    instead.
    """
    return {
        "generated_at": provenance["generated_at"],
        "measured_at": provenance["anchors"]["executable_depth_anchor"]["iso"],
        "volume_to": provenance["anchors"]["swap_tape_end"]["iso"],
        "subsidy": provenance["subsidy"]["note"],
        "full_provenance": "/data/meta.json",
    }


def write_address(addr: str, state, lo: int, hi: int, out: Path, provenance: dict) -> None:
    """One address's detail, whether or not it qualifies for the ranking.

    SEARCH MUST WORK FOR EVERY ADDRESS THAT TRADED, not just the ones shown. The ranking is
    a display choice; finding yourself outside it is the point of a search box. An address
    with no completed round-trip gets a record explaining what it did do and why that does
    not produce a realized figure — "no results" would be both unhelpful and wrong, since
    the address is on the tape.

    No account value, equity, unrealized PnL, leverage or open positions: those need the
    transfer index and a balance engine, and a dash in their place would read as a measured
    zero. They are absent, not empty.
    """
    trips = state["detail"][addr]
    holds = sorted(state["holds"][addr])
    median_hold = holds[len(holds) // 2] if holds else 0
    avg_hold = sum(holds) / len(holds) if holds else 0
    stats = {"round_trips": len(trips), "median_hold": median_hold,
             "fast_trips": sum(1 for t in trips if t["held"] <= 2),
             "buys": state["buys"][addr], "sells": state["sells"][addr],
             "changes": state["changes"][addr]}
    earned = classify(stats)
    per_token = defaultdict(lambda: {"round_trips": 0, "realized": 0.0, "matched": 0.0, "wins": 0})
    for t in trips:
        e = per_token[t["token"]]
        e["round_trips"] += 1
        e["realized"] += t["realized"]
        e["matched"] += t["qty"] * t["sell"] + t["qty"] * t["buy"]
        e["wins"] += t["realized"] > 0
    total_vol = state["total"][addr]
    qualifies = len(trips) > 0
    payload = {
        "address": addr,
        "status": "qualified" if qualifies else "no_round_trips",
        "window": {"from_ts": lo, "to_ts": hi},
        "summary": {
            "realized": state["realized"][addr],
            "round_trips": len(trips),
            "win_rate": state["wins"][addr] / max(len(trips), 1) * 100,
            "matched_volume": state["matched"][addr],
            "total_volume": total_vol,
            "matched_share_pct": state["matched"][addr] / total_vol * 100 if total_vol else 0,
            "out_of_scope_volume": state["unmatched"][addr],
            "out_of_scope_pct": state["unmatched"][addr] / total_vol * 100 if total_vol else 0,
            "position_changes": state["changes"][addr],
            "tokens_traded": len(state["tokens"][addr]),
            "median_hold_s": median_hold,
            "avg_hold_s": avg_hold,
            "longest_win_streak": longest_streak(trips),
            "style": style_of(median_hold),
            "style_basis": "derived from median hold only",
            "first_ts": state["first"].get(addr), "last_ts": state["last"].get(addr),
        },
        "labels": [dict(l, earned=l["id"] in earned) for l in LABELS],
        "sequence": [1 if t["realized"] > 0 else 0 for t in trips][-120:],
        "series": downsample([[int(t), round(v, 6)] for t, v in state["series"][addr]]),
        "round_trips": sorted(trips, key=lambda t: -t["closed"])[:200],
        # Most recent position changes. Capped: the tab shows a recent history, not an
        # archive, and shipping every move would multiply the file for rows nobody scrolls to.
        "trades": sorted(state["moves"][addr], key=lambda m: -m["ts"])[:100],
        "daily": daily_breakdown(trips),
        "tokens": sorted(
            ({"token": k, **v, "win_rate": v["wins"] / max(v["round_trips"], 1) * 100}
             for k, v in per_token.items()),
            key=lambda x: -x["realized"]),
        "provenance": slim_provenance(provenance),
    }
    if not qualifies:
        # Why there is no realized figure, in terms of what this address actually did.
        payload["explain"] = {
            "headline": "No completed round-trips on-chain in this window.",
            "detail": "Realized PnL is only computed where an address bought a token "
                      "on-chain and later sold it on-chain. This address traded, but no "
                      "sale here matched an earlier on-chain buy by the same address.",
            "why": ("Every sale was of units acquired somewhere else — bridged in, issued "
                    "by Robinhood, or transferred from another wallet. That is the normal "
                    "way to hold a tokenized equity, and it is not a judgement about the "
                    "address."
                    if state["sells"][addr] > 0 else
                    "This address only bought in this window. A round-trip needs a sale "
                    "as well, and it has not sold yet."),
            "not_estimated": "No cost basis is guessed for units acquired off-chain, so no "
                             "profit figure is shown rather than an invented one.",
        }
    def plain(o):
        """numpy scalars are not JSON. Coerce at the boundary, not at every call site."""
        if isinstance(o, (np.integer,)):
            return int(o)
        if isinstance(o, (np.floating,)):
            return float(o)
        raise TypeError(f"not JSON serialisable: {type(o)}")

    shard = out / addr[2:4]
    shard.mkdir(parents=True, exist_ok=True)
    (shard / f"{addr}.json").write_text(
        json.dumps(payload, separators=(",", ":"), allow_nan=False, default=plain))


def write_token_logos(tokens: pl.DataFrame, web: Path) -> dict:
    """Map ticker -> logo filename, for the tickers where that map is unambiguous.

    The logo files are named by contract address; the shipped data names tokens by
    ticker.  Three tickers in the registry resolve to more than one address ("P" covers
    four), and there is no way to tell from a row which one it means, so those are left
    without a logo and fall back to the initials tile.  A wrong logo is worse than none:
    it puts another company's mark on somebody's trade.
    """
    logo_dir = web / "token-logos"
    files = {p.stem.lower(): p.name for p in logo_dir.iterdir()
             if p.is_file() and p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}}
    rwa = tokens.filter(pl.col("kind") == "rwa_spot")
    by_ticker: dict[str, list[str]] = defaultdict(list)
    for row in rwa.iter_rows(named=True):
        by_ticker[row["symbol"]].append(row["address"].lower())
    mapping = {t: files[a[0]] for t, a in by_ticker.items()
               if len(a) == 1 and a[0] in files}
    ambiguous = sorted(t for t, a in by_ticker.items() if len(a) > 1)
    (web / "data" / "tokens.json").write_text(json.dumps(mapping, sort_keys=True))
    print(f"token logos: {len(mapping):,} of {len(by_ticker):,} tickers resolve to a file; "
          f"{len(files):,} files on disk; ambiguous tickers skipped: {ambiguous}")
    return mapping


def main() -> int:
    import sys
    sys.path.insert(0, str(HERE))
    from upstream import lp_terminal  # noqa: PLC0415
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="edge")
    args = ap.parse_args()

    root = lp_terminal()
    web = HERE.parent / "web"
    write_token_logos(
        pl.read_parquet(root / "out" / "raw" / "tokens" / "part-00000.parquet"), web)
    df = load(root, args.source)
    trades = netted(df)
    lo, hi = int(trades["ts"].min()), int(trades["ts"].max())
    span_h = (hi - lo) / 3600
    print(f"resolved window: {span_h:.1f} hours, {len(trades):,} position changes, "
          f"{trades['tx_from'].n_unique():,} addresses")

    OUT.mkdir(parents=True, exist_ok=True)
    meta = json.loads((HERE.parent / "web" / "data" / "meta.json").read_text())
    windows = {"1d": 24, "7d": 168, "all": math.ceil(span_h)}
    index = {"provenance": meta["provenance"], "windows": [], "categories": [],
             "generated_from": args.source}

    for name, hours in windows.items():
        if hours > span_h + 0.5 and name != "all":
            continue
        w = trades.filter(pl.col("ts") >= hi - hours * 3600)
        wlo = int(w["ts"].min())
        state = fold(w)
        rows, qualifying_total = build(state, wlo, hi)
        addresses = w["tx_from"].n_unique()
        qualifying = qualifying_total
        total_vol = sum(state["total"].values())
        matched_vol = sum(state["matched"].values())
        payload = {
            "window": name,
            "hours": round((hi - wlo) / 3600, 1),
            "from_ts": wlo, "to_ts": hi,
            "category": "rwa", "quote": "USDG",
            "coverage": {
                "window_label": {"1d": "the last 24 hours", "7d": "the last 7 days",
                                 "all": "the whole resolved window"}.get(name, name),
                "universe": "236 tokenized-equity pools quoting USDG",
                "universe_note": "Pons pools are not included, and this is the resolved "
                                 "window rather than the full 74-day tape.",
                "rows_shown": len(rows),
                "addresses_seen": addresses,
                "addresses_qualifying": qualifying,
                "qualifying_pct": qualifying / max(addresses, 1) * 100,
                "matched_flow_pct": matched_vol / max(total_vol, 1) * 100,
                "total_volume_usd": total_vol,
                "matched_volume_usd": matched_vol,
                "note": "Realized PnL is round-trips only: bought and sold on-chain. "
                        "Holdings acquired any other way are out of scope, not estimated.",
                "truncation_note": f"Ranked rows are capped at {ROW_LIMIT:,}; the full "
                                   "qualifying set is larger and the page states both.",
            },
            "rows": rows,
            "provenance": meta["provenance"],
        }
        path = OUT / f"rwa-usdg-{name}.json"
        path.write_text(json.dumps(payload, separators=(",", ":"), allow_nan=False))
        if name == "all":
            detail_dir = OUT.parent / "address"
            everyone = sorted(state["total"])
            for a in everyone:
                write_address(a, state, wlo, hi, detail_dir, meta["provenance"])
            ranked = sum(1 for a in everyone if state["trips"][a] > 0)
            print(f"        wrote {len(everyone):,} address files "
                  f"({ranked:,} qualifying, {len(everyone) - ranked:,} with no round-trip)"
                  f" -> web/data/address/")
        index["windows"].append({"window": name, "hours": payload["hours"],
                                 "file": f"rwa-usdg-{name}.json",
                                 "rows": len(rows), "coverage": payload["coverage"]})
        print(f"  {name:>4}: {payload['hours']:>5.1f}h  {addresses:>6,} addresses, "
              f"{qualifying:>5,} qualify ({payload['coverage']['qualifying_pct']:.1f}%), "
              f"matched flow {payload['coverage']['matched_flow_pct']:.1f}%  -> {path.name}")

    index["categories"] = [
        {"id": "rwa", "label": "RWA", "available": True,
         "note": "Tokenized equities. All 236 pools quote in USDG."},
        {"id": "pons", "label": "Pons", "available": False,
         "note": "Identity resolution not finished. Not shown rather than shown empty."},
    ]
    index["quotes"] = [{"id": "usdg", "label": "USDG", "available": True},
                       {"id": "eth", "label": "ETH", "available": False,
                        "note": "Pons pools quote in native ETH; needs a price series."}]
    (OUT / "index.json").write_text(json.dumps(index, separators=(",", ":"), allow_nan=False))
    print(f"\nwrote {OUT}/index.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
