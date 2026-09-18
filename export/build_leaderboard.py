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
import os
import re
import time
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
DAY = 86400
HOUR = 3600
ASSET_SERIES_CAP = 200
ASSET_TRADES = 50
# How many wallets the asset page's cluster draws. The panel is one box; past roughly this
# many circles the small ones stop being legible and start being texture.
ASSET_POSITIONS = 28
# What /api/asset/:symbol can spell, kept in step with web-api.mjs by hand.
#
# WIDE ON PURPOSE. This was [A-Za-z0-9.]{1,16}, which dropped three Pons tokens named in
# emoji and Chinese — and the leaderboard lists those tokens in its own rows, so the asset
# list disagreed with the board about which tokens exist. A symbol is data from the chain,
# not an identifier we get to choose, and the one thing a URL actually needs is that it can
# be percent-encoded and round-trip: that rules out path separators and control characters,
# and nothing else.
#
# What is refused, and why:
#   / and \   a path separator would make the symbol a path
#   . and ..  the two names every filesystem reserves for somewhere else
#   control   including newline and tab: invisible, and unloggable without escaping
#   empty     nothing to address
#   > 32      a cap, because a symbol is a ticker and this one is already generous
ASSET_SYMBOL_MAX = 32
_UNADDRESSABLE = re.compile(r"[/\\\x00-\x1f\x7f]")


def addressable(symbol: str | None) -> bool:
    """Whether /api/asset/:symbol can carry this symbol there and back."""
    if not symbol or symbol in {".", ".."}:
        return False
    if len(symbol) > ASSET_SYMBOL_MAX:
        return False
    return not _UNADDRESSABLE.search(symbol)


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
    from registry import tokens as _tokens  # noqa: PLC0415
    tok = _tokens()
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
    universes = defaultdict(set)
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
    # Volume by the asset the trade was quoted in. The fold already carries the column and
    # threw it away; the detail view has no honest answer to "what does this address
    # actually trade against" without it.
    by_quote = defaultdict(lambda: defaultdict(float))

    for addr, tick, cat, qty, quote_delta, ts, quote in zip(
            trades["addr"], trades["label"], trades["cat"], trades["qty"].to_numpy(),
            trades["usd"].to_numpy(), trades["ts"].to_numpy(), trades["quote"]):
        notional = abs(quote_delta)
        total[addr] += notional
        by_quote[addr][quote] += notional
        tokens[addr].add(tick)
        changes[addr] += 1
        moves[addr].append({"ts": int(ts), "token": tick, "side": "buy" if qty > 0 else "sell",
                            "qty": abs(float(qty)), "value": notional,
                            "price": notional / abs(float(qty)) if abs(qty) > DUST else 0.0})
        first_seen.setdefault(addr, int(ts))
        last_seen[addr] = int(ts)
        universes[addr].add(cat)
        # Books never cross a universe: an RWA ticker and a Pons pool are different
        # inventory, and matching across them would invent a round-trip.
        key = (addr, cat, tick)
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
            "changes": changes, "first": first_seen, "last": last_seen, "moves": moves,
            "universes": universes, "by_quote": by_quote}


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


def windows_for(span_h: float, windows: dict) -> tuple[dict, str | None]:
    """Which declared windows this tape can support, and which one detail records come from.

    A window wider than the tape is not built: a 7d ranking over 48 hours of trades is a
    48-hour ranking wearing a label that says otherwise. The second return is the widest
    window that IS built, and it is the one every address payload is written from.

    THE TWO ANSWERS HAVE TO COME FROM THE SAME PLACE. They used to be independent: the
    windows were filtered against the tape, and the detail writer was keyed on the literal
    string "7d". On a tape younger than seven days that is every scope ranked and not one
    payload stored, and the ranked rows point at addresses the store has never heard of.
    Because every window is a suffix ending at the same instant, the widest one built holds
    a superset of every narrower one's addresses, which is what makes the coverage true by
    construction rather than by coincidence.
    """
    built = {n: h for n, h in windows.items() if h <= span_h + 0.5}
    return built, (max(built, key=lambda n: built[n]) if built else None)


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
            # The raw count too, not only the rate. The card's evidence bar compares this
            # record against what a coin-flipper of the same size would produce, and that
            # comparison needs n and k, not a percentage it would have to invert.
            "wins": int(state["wins"][addr]),
            "round_trips": trips,
            "last_ts": int(state["last"][addr]) if addr in state["last"] else None,
            "tokens": sorted(state["tokens"][addr])[:4],
            "token_count": len(state["tokens"][addr]),
            "out_of_scope_volume": state["unmatched"][addr],
        })
    rows.sort(key=lambda r: -r["realized"])
    shipped = rows[:limit]
    for i, r in enumerate(shipped, 1):
        r["rank"] = i
        # The podium gets a wide sparkline and the cards on the copy-trade page get one
        # each, so every shipped row carries the series now. It is the file's largest
        # single cost, so it stays coarse: 24 points is all either drawing resolves.
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


def max_drawdown(series: list) -> dict:
    """The deepest fall of the realized curve, over EVERY close.

    Computed here, before `downsample`, because a 500-point sample of a 2,800-close curve
    can step straight over the trough: the figure taken from the shipped series is a lower
    bound, not the drawdown. The curve starts at zero, so an address that only ever lost is
    in drawdown from its first close rather than showing none.

    This is not account drawdown. Nothing here knows what the address holds, so an open
    position that halved contributes nothing; it is the fall of the closed-round-trip
    total, and the interface labels it as that.
    """
    peak = 0.0
    peak_ts = None
    best = {"depth": 0.0, "peak": 0.0, "trough": 0.0, "from_ts": None, "to_ts": None,
            "closes": len(series)}
    for ts, value in series:
        if value > peak:
            peak, peak_ts = value, int(ts)
        fall = peak - value
        if fall > best["depth"]:
            best = {"depth": fall, "peak": peak, "trough": value, "from_ts": peak_ts,
                    "to_ts": int(ts), "closes": len(series)}
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


def swap_positions(part: pl.DataFrame, price: float | None, ranked: set[str]) -> list[dict]:
    """Per-wallet net position in one token, from the swap tape alone.

    WHAT THIS IS, AND WHAT IT IS NOT. For each address that swapped this token in the window:
    units bought minus units sold, and a FIFO cost for the units still unsold. That is a
    position built out of on-chain buying, not a holding. A wallet can hold more than this —
    anything transferred or bridged in is invisible to a swap tape — and a wallet that sold
    units it never bought here comes out negative, which means exactly that: its supply came
    from somewhere this build cannot see. Those are dropped rather than drawn as a short.

    So the asset page may not label these "holders", and the header's HOLDERS / IN PROFIT /
    AVG ENTRY figures stay unwired: those are statements about everyone who holds the token,
    which still needs an ERC-20 transfer index.

    FIFO, NOT AN AVERAGE BUY PRICE. A wallet that bought at 10 and 30 and sold one unit has a
    remaining cost of 30, not 20. Averaging over every buy would price units that are gone.
    The walk is per address and only for the ones that make the cut, so it costs a pass over
    a few hundred rows rather than over the tape.
    """
    if price is None or not math.isfinite(price):
        return []
    g = (part.group_by("addr")
         .agg(pl.col("qty").sum().alias("net"), pl.col("qty").abs().sum().alias("gross"))
         .filter(pl.col("net") > 0)
         .sort("net", descending=True)
         .head(ASSET_POSITIONS))
    if g.height == 0:
        return []
    keep = set(g["addr"].to_list())
    lots: dict[str, list[list[float]]] = {a: [] for a in keep}
    for addr, qty, usd in zip(part["addr"].to_list(), part["qty"].to_list(), part["usd"].to_list()):
        if addr not in keep:
            continue
        q = float(qty)
        if q > 0:
            lots[addr].append([q, abs(float(usd)) / q if q > DUST else 0.0])
            continue
        # A sell eats the oldest lots first; one that eats more than was ever bought here is
        # selling units this tape never saw arrive, and simply empties the queue.
        left = -q
        while left > DUST and lots[addr]:
            lot = lots[addr][0]
            take = min(left, lot[0])
            lot[0] -= take
            left -= take
            if lot[0] <= DUST:
                lots[addr].pop(0)
    out = []
    for addr, net in zip(g["addr"].to_list(), g["net"].to_list()):
        held = sum(lot[0] for lot in lots[addr])
        cost = sum(lot[0] * lot[1] for lot in lots[addr])
        entry = cost / held if held > DUST else None
        out.append({
            "address": addr,
            "units": float(net),
            "value": float(net) * price,
            # None, not zero: a wallet whose remaining units were all bought below DUST or
            # came out of an empty queue has no entry price to compare against.
            "entry": float(entry) if entry else None,
            "pnl_pct": (price - entry) / entry * 100 if entry else None,
            "ranked": addr in ranked,
        })
    return out


def price_at(ts: np.ndarray, prices: np.ndarray, when: int) -> float | None:
    """The last trade at or before `when`, or None when the tape holds none that old.

    None is not zero and not "unchanged": a token whose first trade is inside the window
    has nothing to measure a change from, and so does every token when the tape itself is
    younger than the lookback. The page shows nothing for it.
    """
    i = int(np.searchsorted(ts, when, side="right")) - 1
    if i < 0:
        return None
    p = float(prices[i])
    return p if p > 0 else None


def assets(trades: pl.DataFrame, to_ts: int, ranked: set[str] | None = None,
           history: pl.DataFrame | None = None, supply: dict[str, dict] | None = None) -> list[dict]:
    """Per-asset aggregates, folded from the same window the ranking is.

    THE SAME WINDOW, NOT A SECOND PASS OVER THE TAPE. These rows and the leaderboard rows
    are read side by side on the site, and two aggregations over two windows would disagree
    about volume by whatever arrived in between and look like a bug in one of them.

    PRICE IS AN EXECUTION, NOT A QUOTE. It is the most recent trade's own abs(usd)/abs(qty),
    so it is a price somebody actually paid. Rows under DUST are skipped for anything
    price-bearing: a quantity that small divides into a price of thousands or of nothing,
    and one of them would become this asset's headline number. Those rows still count
    towards volume and the trade count, because they did happen.

    change24h IS None WHEN THE WINDOW HOLDS NO TRADE THAT OLD. Not zero: zero is "it did
    not move", which is a measurement, and this is the absence of one. It stays None
    through the store and out of the API, and the page has to decide what to show for it.

    There are no holders and no holder count. That needs an ERC-20 transfer index this
    build does not have, and a zero in its place would read as a measured zero.

    Returns one payload per asset, richest first, each {asset, series, trades}: the summary
    row is nested rather than spread because the summary's `trades` is a count and the
    detail's is a list, and one key cannot honestly mean both.
    """
    day_ago = to_ts - DAY
    ranked = ranked or set()
    supply = supply or {}
    # PRICE CHANGES READ A LONGER TAPE THAN THE VOLUMES DO. Volume, traders and trade
    # counts are the window's, because those are the figures read beside the leaderboard
    # and two aggregations over two windows would disagree. A 7-day change cannot come from
    # a 7-day window at all: the reference price is the last trade at or BEFORE the
    # boundary, which by definition sits outside it. So the changes are measured against
    # the whole tape the build holds, and where the tape is younger than the lookback the
    # figure is absent rather than wrong.
    past = {}
    if history is not None:
        for part in history.sort("ts").partition_by("label", maintain_order=True):
            priced_h = part.filter((pl.col("qty").abs() > DUST) & pl.col("usd").is_finite())
            if priced_h.height == 0:
                continue
            h_ts = priced_h["ts"].to_numpy()
            h_px = np.abs(priced_h["usd"].to_numpy()) / np.abs(priced_h["qty"].to_numpy())
            past[part["label"][0]] = (h_ts, h_px)
    out, skipped = [], []
    for part in trades.sort("ts").partition_by("label", maintain_order=True):
        symbol = part["label"][0]
        if not addressable(symbol):
            skipped.append(symbol)
            continue
        usd = np.abs(part["usd"].to_numpy())
        ts = part["ts"].to_numpy()
        priced = part.filter((pl.col("qty").abs() > DUST) & pl.col("usd").is_finite())
        pts = priced["ts"].to_numpy()
        pqty = np.abs(priced["qty"].to_numpy())
        pusd = np.abs(priced["usd"].to_numpy())
        prices = pusd / pqty
        # A PRICE OF ZERO IS NOT A PRICE. One token on this tape (OPAI) trades quantities
        # large enough, against a quote side small enough, that its last execution divides
        # out to exactly 0.0 — and a zero price propagates into a zero change and a zero
        # market cap, each of which reads as a measurement. None of them are, so the token
        # keeps its volume and its trade count and shows nothing for the rest.
        price = float(prices[-1]) if len(prices) and prices[-1] > 0 else None
        # The last trade at or before the boundary, by position: the window is sorted, so
        # this is a lookup rather than a second filter.
        h_ts, h_px = past.get(symbol, (pts, prices))
        def moved(seconds: int) -> float | None:
            """Percent change from the last trade at or before `seconds` ago to the last."""
            if price is None:
                return None
            ref = price_at(h_ts, h_px, to_ts - seconds)
            return (price - ref) / ref * 100 if ref else None
        change = moved(DAY)
        change1h = moved(HOUR)
        change7d = moved(7 * DAY)
        series = []
        if len(pts):
            # One point per hour, and the point is the last trade in that hour rather than
            # a mean of it: a mean is a price nothing traded at.
            hour = pts // 3600
            for i in np.flatnonzero(np.append(hour[1:] != hour[:-1], True)):
                series.append([int(pts[i]), float(prices[i])])
        held = supply.get(symbol)
        sup = float(held["supply"]) if held and held["supply"] > 0 else None
        sup_at = int(held["read_at"]) if held else None
        cap = price * sup if (price is not None and sup) else None
        if cap is not None and cap < 0.01:
            cap = None
        addrs = priced["addr"].to_list()
        signed = priced["qty"].to_numpy()
        positions = swap_positions(priced, price, ranked)
        recent = [{"ts": int(pts[i]), "address": addrs[i],
                   "side": "buy" if signed[i] > 0 else "sell",
                   "qty": float(pqty[i]), "price": float(prices[i]),
                   "value": float(pusd[i])}
                  for i in range(len(pts) - 1, max(len(pts) - ASSET_TRADES, 0) - 1, -1)]
        out.append({
            "asset": {
                "symbol": symbol,
                # The two universes under the names the site uses for them. 'rwa' and
                # 'pons' are what the tape calls them and mean nothing to a reader.
                "kind": "stock" if part["cat"][-1] == "rwa" else "meme",
                "price": price,
                "change1h": change1h,
                "change24h": change,
                "change7d": change7d,
                "volume24h": float(usd[ts > day_ago].sum()),
                "volume": float(usd.sum()),
                "traders": part["addr"].n_unique(),
                "trades": part.height,
                # SUPPLY IS THIS CHAIN'S, AND SO IS THE CAP. totalSupply() counts the
                # tokens issued on Robinhood Chain — for a tokenized equity that is a
                # fraction of the company's shares, and the cap below is the token's, not
                # the company's. The site's column says so; this is where it comes from.
                "supply": sup,
                "supply_read_at": sup_at,
                # A cap under a cent is the same non-figure as a price of zero: it is what
                # a denormal price times a supply produces, and it would print as "$0".
                "market_cap": cap,
            },
            "series": downsample(series, ASSET_SERIES_CAP),
            "positions": positions,
            "trades": recent,
        })
    out.sort(key=lambda a: -a["asset"]["volume"])
    if skipped:
        # Said out loud. Dropping them in silence is how a universe quietly shrinks.
        print(f"assets: {len(skipped)} symbol(s) the API route cannot address, "
              f"skipped: {skipped}")
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


def percentile_of(value: float, ranked) -> float:
    """Where this address sits in the qualifying field, as a percentile.

    A dollar figure alone does not say whether it beat anyone. The median qualifying
    address made 83 cents, so $40 is not a small result here and $1,000 is not a modest one.
    """
    import bisect  # noqa: PLC0415
    return bisect.bisect_left(ranked, value) / max(len(ranked), 1) * 100


def write_address(addr: str, state, lo: int, hi: int, out: Path | None, provenance: dict,
                  ranked=None, context=None):
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
            "percentile": percentile_of(state["realized"][addr], ranked)
            if (ranked and state["trips"][addr] > 0) else None,
            # Which asset this address's volume is priced in. Not a direction and not a
            # rating — ETH-quoted flow is converted at the trade's own timestamp, so a
            # reader is entitled to know how much of a figure went through that step.
            # The deepest fall of the realized curve, over every close rather than over
            # the sampled series the chart draws. Not account drawdown: see max_drawdown.
            "realized_drawdown": max_drawdown(state["series"][addr]),
            "quote_mix": [{"quote": q, "volume": v,
                           "pct": v / total_vol * 100 if total_vol else 0}
                          for q, v in sorted(state["by_quote"].get(addr, {}).items(),
                                             key=lambda kv: -kv[1])],
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
        # Which universes this address traded. Not a category on the grid — it is not
        # something a reader acts on there — but it is a fact about this address.
        "universes": sorted(state["universes"].get(addr, [])),
        # The field, so a dollar figure can be read against what everyone else did.
        "field": context or {},
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

    if out is None:
        # Round-trip through json so the store sees exactly what a file would have held:
        # numpy scalars and sets are not JSON, and `default=plain` is where that is handled.
        return json.loads(json.dumps(payload, allow_nan=False, default=plain))
    shard = out / addr[2:4]
    shard.mkdir(parents=True, exist_ok=True)
    (shard / f"{addr}.json").write_text(
        json.dumps(payload, separators=(",", ":"), allow_nan=False, default=plain))


def ticker_addresses(tokens: pl.DataFrame) -> dict[str, str]:
    """ticker -> contract address, for the tickers where that map is unambiguous.

    The same rule the logo map uses, for the same reason: three tickers in the registry
    resolve to more than one address ("P" covers four), and a supply read off the wrong
    contract is a market cap for a different company. Those tickers get nothing.
    """
    rwa = tokens.filter(pl.col("kind") == "rwa_spot")
    by_ticker: dict[str, list[str]] = defaultdict(list)
    for row in rwa.iter_rows(named=True):
        by_ticker[row["symbol"]].append(row["address"].lower())
    out = {t: a[0] for t, a in by_ticker.items() if len(a) == 1}
    # The Pons side, whose symbols the equity registry never carried.
    try:
        from token_decimals import symbols as chain_symbols  # noqa: PLC0415
        for addr, sym in chain_symbols().items():
            out.setdefault(sym, addr.lower())
    except Exception:                                        # noqa: BLE001
        pass
    return out


def supplies(tokens: pl.DataFrame) -> dict[str, dict]:
    """ticker -> {supply, read_at}, from the last totalSupply() read.

    Absent for a ticker whose contract did not answer, whose decimals are unknown, or
    which does not resolve to exactly one address. Absent is the answer the site shows as
    nothing; there is no zero anywhere in this path.
    """
    try:
        from token_supply import known as supply_known  # noqa: PLC0415
    except Exception:                                    # noqa: BLE001
        return {}
    by_addr = supply_known()
    if not by_addr:
        return {}
    return {t: by_addr[a] for t, a in ticker_addresses(tokens).items() if a in by_addr}


def write_token_logos(tokens: pl.DataFrame, web: Path, store=None) -> dict:
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
    # Also key by contract address. 204 of the logo files are for tokens the equity
    # registry never named — Pons tokens whose symbol had to be read off the chain — and
    # a ticker-only map cannot reach them.
    from token_decimals import symbols as chain_symbols  # noqa: PLC0415
    for addr, name in files.items():
        mapping.setdefault(addr, name)
    for a, sy in chain_symbols().items():
        if a.lower() in files:
            mapping.setdefault(sy, files[a.lower()])
    ambiguous = sorted(t for t, a in by_ticker.items() if len(a) > 1)
    (web / "data" / "tokens.json").write_text(json.dumps(mapping, sort_keys=True))
    # Also into the store: the container has no checked-in web/data, so a page
    # that fetched the file would silently lose every logo before the first cycle.
    if store is not None:
        store.put_leaderboard("tokens", "tokens", mapping)
    tickers = sum(1 for k in mapping if not k.startswith("0x"))
    print(f"token logos: {len(files):,} files -> {tickers:,} tickers and "
          f"{len(mapping) - tickers:,} contract addresses; ambiguous skipped: {ambiguous}")
    return mapping


def main() -> int:
    import sys
    sys.path.insert(0, str(HERE))
    from universe import SCOPES, apply_scope, combined  # noqa: PLC0415
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="edge")
    args = ap.parse_args()

    import gates as gatemod  # noqa: PLC0415
    from store import Store, new_build_id  # noqa: PLC0415
    # The registry is vendored, so this build no longer needs an lp-terminal checkout.
    # The path is still honoured when it is set, because a machine that has the full
    # registry should read the real thing rather than a 1.3 MB subset of it.
    root = Path(os.environ.get("PEAPOD_LP_TERMINAL", "")).expanduser() \
        if os.environ.get("PEAPOD_LP_TERMINAL") else HERE.parent
    web = HERE.parent / "web"
    store = Store(Path(os.environ.get("PEAPOD_DB", str(HERE.parent / "var" / "peapod.db"))))
    build_id = new_build_id()
    # What the store holds now, captured before the transaction opens: inside it the
    # values the gates compare against are already gone.
    before = gatemod.snapshot(store)
    # One transaction for the whole cycle. WAL gives readers the previous build until this
    # commits, so a crash halfway rolls back rather than serving half a ranking.
    store.begin()
    write_token_logos(__import__("registry").tokens(), web, store)
    # Read by ingest/token_supply.py at the top of the cycle; absent on a cold volume, and
    # then every supply-derived figure is simply absent too.
    supply_table = supplies(__import__("registry").tokens())

    trades = combined(root, args.source)
    lo, hi = int(trades["ts"].min()), int(trades["ts"].max())
    span_h = (hi - lo) / 3600
    by_cat = trades.group_by("cat").agg(pl.col("addr").n_unique().alias("addrs"),
                                        pl.len().alias("changes"))
    print(f"resolved window: {span_h:.1f} hours, {len(trades):,} position changes, "
          f"{trades['addr'].n_unique():,} addresses")
    for r in by_cat.sort("cat").iter_rows(named=True):
        print(f"    {r['cat']:<5} {r['changes']:>9,} changes  {r['addrs']:>7,} addresses")

    OUT.mkdir(parents=True, exist_ok=True)
    meta = json.loads((web / "data" / "meta.json").read_text())
    windows = {"1d": 24, "7d": 168}
    index = {"provenance": meta["provenance"], "generated_from": args.source,
             "scopes": [], "windows": [], "views": []}
    headline = {"qualifying": 0, "top": 0.0, "addresses": 0}
    ranked_any: set[str] = set()
    # Empty unless the detail window builds; the gate that reads it then has nothing to say
    # rather than a KeyError on a build that shipped no assets.
    shipped_asset_rows: list[dict] = []
    buildable, detail_window = windows_for(span_h, windows)
    for name, hours in windows.items():
        if name not in buildable:
            # Said out loud. Skipping in silence is what made a build that stored no detail
            # records at all read as "all seven scopes built".
            print(f"   {name:>3} skipped: {hours}h window, {span_h:.1f}h of tape")
    widest = None

    for name, hours in buildable.items():
        w_all = trades.filter(pl.col("ts") >= hi - hours * 3600)
        wlo = int(w_all["ts"].min())
        for scope in SCOPES:
            # A scope refolds the FIFO on its own trades. Filtering rows instead would
            # leave a "Pons" table whose numbers still contained RWA profit, because 68
            # of the top 100 trade both.
            w = apply_scope(w_all, scope)
            if not w.height:
                continue
            state = fold(w)
            rows, qualifying = build(state, wlo, hi)
            addresses = w["addr"].n_unique()
            total_vol = sum(state["total"].values())
            matched_vol = sum(state["matched"].values())
            realized = [state["realized"][a] for a in state["trips"] if state["trips"][a] > 0]
            arr = np.array(realized) if realized else np.zeros(1)
            wins = int((arr > 0).sum())
            payload = {
                "scope": scope["id"], "scope_label": scope["label"],
                "window": name,
                "hours": round((hi - wlo) / 3600, 1),
                "from_ts": wlo, "to_ts": hi,
                "coverage": coverage_block(scope, name, rows, addresses, qualifying,
                                           total_vol, matched_vol, arr, wins),
                "distribution": distribution_block(arr, wins),
                "rows": rows,
                "provenance": meta["provenance"],
            }
            store.put_leaderboard(scope["id"], name, payload)
            # Every address that appears on any board, for the asset page's cluster: a bubble
            # whose wallet also ranks gets the frame's heavier ring, which is a second fact
            # about it rather than a louder opinion about its PnL.
            ranked_any.update(r["address"] for r in rows)
            if scope["id"] == "all" and (widest is None or hours >= widest[1]):
                headline = {"qualifying": qualifying, "top": float(arr.max()),
                            "addresses": addresses}
            path = OUT / f"{scope['id']}-{name}.json"
            path.write_text(json.dumps(payload, separators=(",", ":"), allow_nan=False))
            index["views"].append({"scope": scope["id"], "window": name,
                                   "file": path.name, "rows": len(rows),
                                   "coverage": payload["coverage"],
                                   "distribution": payload["distribution"]})
            print(f"  {name:>3} {scope['id']:<10} {addresses:>7,} traded  "
                  f"{qualifying:>6,} qualify  top ${arr.max():>11,.0f}  "
                  f"p50 ${np.median(arr):>8,.2f}  -> {path.name}")

        if name == detail_window:
            widest = (name, hours, w_all, wlo)

    # DETAIL RECORDS COVER EVERY RANKED ADDRESS BECAUSE THEY COME FROM THE WIDEST WINDOW.
    # Every window is a suffix of the tape ending at the same instant, so a narrower one
    # holds a subset of these trades and therefore a subset of these addresses. Writing
    # from the widest window that built is what makes "every ranked address has a detail
    # record" true by construction rather than by coincidence.
    if widest is not None:
        name, _hours, w_all, wlo = widest
        state = fold(w_all)
        rows_all, qual_all = build(state, wlo, hi)
        ranked = sorted((state["realized"][a] for a in state["trips"]
                         if state["trips"][a] > 0))
        everyone = sorted(state["total"])
        ctx = {"qualifying": qual_all, "traded": len(everyone),
               "median": float(np.median(ranked)) if ranked else 0.0,
               "at_a_loss_pct": float(np.mean(np.array(ranked) < 0) * 100) if ranked else 0.0}
        written = store.put_addresses(
            (write_address(a, state, wlo, hi, None, meta["provenance"],
                           ranked=ranked, context=ctx) for a in everyone), build_id)
        print(f"        stored {written:,} addresses from the {name} window "
              f"({qual_all:,} qualifying, {written - qual_all:,} with no round-trip)")
        # Assets come off the same frame as the detail records, for the same reason: the
        # widest window that built is the one every other payload is written from, so an
        # asset page and the address pages that link to it cannot disagree about the window.
        # `trades` — the whole tape, not the window — for the price lookbacks: a 7-day
        # change measures against a trade that sits outside a 7-day window by definition.
        asset_payloads = assets(w_all, hi, ranked_any, history=trades, supply=supply_table)
        shipped_asset_rows = [a["asset"] for a in asset_payloads]
        shipped_assets = store.put_assets(asset_payloads, build_id)
        print(f"        stored {shipped_assets:,} assets from the {name} window")

    index["scopes"] = [{"id": s["id"], "label": s["label"], "cat": s["cat"],
                        "quote": s["quote"]} for s in SCOPES]
    index["windows"] = [{"window": n, "label": {"1d": "24h", "7d": "7d"}[n]}
                        for n in windows if any(v["window"] == n for v in index["views"])]
    (OUT / "index.json").write_text(json.dumps(index, separators=(",", ":"), allow_nan=False))
    store.put_leaderboard("index", "index", index)

    # ---- gates. A build that completes and is wrong is the dangerous case; a crash is
    # ---- the easy one. Anything fatal rolls the transaction back, uncommitted.
    eth_stats = None
    eth_path = HERE.parent / "ingest" / "out" / "eth_usd" / "series.parquet"
    if eth_path.exists():
        e = pl.read_parquet(eth_path).sort("ts")
        px = e["price"].to_numpy()
        ets = e["ts"].to_numpy()
        eth_stats = {"points": e.height,
                     "spread_pct": float((px.max() - px.min()) / max(px.min(), 1e-9) * 100),
                     "max_gap_s": int(np.diff(ets).max()) if e.height > 1 else 0}
    ranked = {r["address"] for v in index["views"]
              for r in json.loads((OUT / v["file"]).read_text())["rows"]}
    stored = {row[0] for row in store.db.execute(
        "SELECT addr FROM address WHERE build=?", (build_id,))}
    stats = {"to_ts": hi, "qualifying": headline["qualifying"],
             "top_realized": headline["top"], "addresses": headline["addresses"],
             "scopes": len(index["views"])}
    gaps_path = HERE.parent / "ingest" / "out" / "gaps.json"
    gaps = json.loads(gaps_path.read_text()) if gaps_path.exists() else []
    g = gatemod.run(gatemod.Gates(), before=before, stats=stats, trades=trades,
                    asset_rows=shipped_asset_rows,
                    views=index["views"], declared=[s["id"] for s in SCOPES],
                    missing_ranked=len(ranked - stored),
                    address_count=store.counts()["addresses"], eth=eth_stats, gaps=gaps)
    print("\nverification gates")
    print(g.report())
    print(f"  {gatemod.summarise(g)}")
    if g.failed:
        store.rollback()
        print(f"\nBUILD REJECTED: {len(g.failed)} gate(s) failed. Nothing was committed; "
              f"the store still serves build {before['build']}.")
        return 1
    store.set_meta(gates=g.as_dict(), stats=stats)
    store.set_meta(build=build_id, built_at=int(time.time()), source=args.source,
                   provenance=meta["provenance"], windows=index["windows"],
                   scopes=index["scopes"])
    store.commit()
    store.optimize()
    c = store.counts()
    print(f"\nstore {store.path}: build {build_id}, {c['addresses']:,} addresses "
          f"({c['qualifying']:,} qualifying), {c['leaderboards']} leaderboards, "
          f"{c['assets']:,} assets, "
          f"{c['payload_bytes'] / 1e6:.0f} MB of gzipped payload")
    return 0


UNIVERSE_TEXT = ("236 tokenized-equity pools quoting USDG and 90 Pons pools quoting "
                 "ETH or USDG")


def coverage_block(scope, name, rows, addresses, qualifying, total_vol, matched_vol,
                   arr, wins) -> dict:
    """What the ranking covers, stated before the ranking is read."""
    universe = {
        "rwa": "236 tokenized-equity pools quoting USDG",
        "pons": "90 Pons pools quoting ETH or USDG",
    }.get(scope["cat"] or "", UNIVERSE_TEXT)
    if scope["quote"]:
        universe += f", restricted to pools quoting {scope['quote']}"
    block = {
        "window_label": {"1d": "the last 24 hours", "7d": "the last 7 days"}[name],
        "universe": universe,
        "rows_shown": len(rows),
        "addresses_seen": addresses,
        "addresses_qualifying": qualifying,
        "qualifying_pct": qualifying / max(addresses, 1) * 100,
        "matched_flow_pct": matched_vol / max(total_vol, 1) * 100,
        "total_volume_usd": total_vol,
        "matched_volume_usd": matched_vol,
        "note": "Realized PnL is round-trips only: bought and sold on-chain. Holdings "
                "acquired any other way are out of scope, not estimated.",
        "usd_note": "ETH-quoted legs convert at the trade's own timestamp from this "
                    "chain's ETH/USD series, never at a closing rate.",
        "scope_note": "Switching category or quote refolds the matching on that scope's "
                      "trades. It does not filter rows: most of the top of this table "
                      "trades both universes, so a filtered row would still carry the "
                      "profit it made elsewhere.",
        "truncation_note": f"Ranked rows are capped at {ROW_LIMIT:,}; the full qualifying "
                           "set is larger and the page states both.",
    }
    # A high in-profit rate on a small-magnitude universe is not better trading, and the
    # RWA tab reads exactly that way without being told so.
    if scope["cat"] == "rwa":
        block["magnitude_note"] = (
            f"{wins / max(len(arr), 1) * 100:.1f}% of qualifying RWA addresses are in "
            f"profit against 53.4% on Pons, but the best RWA result in this window is "
            f"${arr.max():,.0f} against ${188638:,.0f} on Pons. The higher success rate "
            "reflects how little is at stake, not better trading.")
    return block


def distribution_block(arr, wins) -> dict:
    """The shape of the field, because the top row is an outlier and reads as the story."""
    pos = arr[arr > 0]
    order = np.sort(arr)[::-1]
    top1 = order[:max(len(order) // 100, 1)]
    return {
        "qualifying": int(len(arr)),
        "percentiles": {str(p): float(np.percentile(arr, p))
                        for p in (100, 99, 95, 75, 50, 25, 5, 1, 0)},
        "in_profit": wins,
        "in_profit_pct": float(wins / max(len(arr), 1) * 100),
        "at_a_loss": int((arr < 0).sum()),
        "at_a_loss_pct": float((arr < 0).mean() * 100),
        "total_won": float(pos.sum()) if len(pos) else 0.0,
        "total_lost": float(arr[arr < 0].sum()) if (arr < 0).any() else 0.0,
        "top1pct_share": float(top1.sum() / pos.sum()) if len(pos) and pos.sum() else 0.0,
    }


if __name__ == "__main__":
    raise SystemExit(main())
