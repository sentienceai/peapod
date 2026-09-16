"""Both universes as one table of trades, in USD.

ONE RANKING, NOT TWO. RWA pools quote in USDG and Pons pools in ETH or USDG, and the two
sets overlap heavily in people: 23,059 addresses trade both, and 68 of the top 100 are in
that overlap. Two separate leaderboards would rank the same person twice on halves of their
record and would put nobody at the top who is actually at the top.

A FILTER RESCOPES, IT DOES NOT HIDE. Because the top of the table is mostly people who
trade both, filtering the ROWS to "Pons" would leave a Pons tab whose numbers still
contained RWA profit. So a scope filters the TRADES and the FIFO is refolded on what
remains. Three folds at build time; seconds.

USD AT THE TRADE. ETH-quoted legs convert at their own timestamp from the chain's own
ETH/USD series (ingest/eth_usd.py). Repricing an ETH total at one closing rate would credit
every trader with the week's move in ETH, which is not a trading result and not theirs.

BOOKS NEVER CROSS A UNIVERSE. FIFO is keyed by (address, category, book) because an RWA
ticker and a Pons pool are different inventory. Matching across them would invent a
round-trip that never happened.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import polars as pl

HERE = Path(__file__).resolve().parent
INGEST = HERE.parent / "ingest" / "out"
sys.path.insert(0, str(HERE.parent / "ingest"))
Q96 = 2 ** 96
DUST = 1e-12

QUOTES = {"USDG": 6, "ETH": 18}


def eth_usd_series() -> tuple[np.ndarray, np.ndarray]:
    path = INGEST / "eth_usd" / "series.parquet"
    if not path.exists():
        raise SystemExit("no ETH/USD series; run ingest/eth_usd.py --stage series first")
    s = pl.read_parquet(path).sort("ts")
    return s["ts"].to_numpy().astype(np.int64), s["price"].to_numpy()


def _block_times(root: Path) -> tuple[np.ndarray, np.ndarray]:
    from partitions import BlockClock  # noqa: PLC0415
    clock = BlockClock.load(root)
    return clock.blocks, clock.times


def _pools():
    from registry import pools  # noqa: PLC0415
    return pools()


def _tokens():
    from registry import tokens  # noqa: PLC0415
    return tokens()


def _decimals(root: Path) -> dict[str, int]:
    from token_decimals import known  # noqa: PLC0415
    tok = _tokens()
    base = {a: int(d) for a, d in zip(tok["address"], tok["decimals"]) if d is not None}
    return known(base)


def _symbols(root: Path) -> dict[str, str]:
    from token_decimals import symbols  # noqa: PLC0415
    tok = _tokens()
    base = {a: s for a, s in zip(tok["address"], tok["symbol"]) if s}
    return symbols(base)


# Read a fixed projection, not whatever columns a part happens to carry.
#
# The tape was written by two generations of the ingest: the older parts have `ts` and no
# block hash, the newer ones carry `block_hash`, `removed` and `ts_unreliable` instead.
# Concatenating them raised a width mismatch the first time a new part was written —
# which, on the container, would have been the first successful ingest. Naming the columns
# the fold actually uses makes the read independent of when a part was written.
# The two tapes do not carry the same fields — the Pons ingest never recorded a sqrt
# price, because PnL there is computed from the amounts alone. Each side names what it
# needs and gets a clear error naming the tape if a column is genuinely missing.
BASE_COLUMNS = ["pool_id", "block", "log_index", "tx_hash", "amount0", "amount1"]
RWA_COLUMNS = [*BASE_COLUMNS, "sqrt_price_x96"]


# The shape combined() concatenates. An absent universe contributes no rows, not a
# different set of columns: a vertical_relaxed concat over mismatched schemas is how a
# column silently becomes null for half the tape.
EMPTY_TRADES = pl.DataFrame(schema={
    "tx": pl.String, "addr": pl.String, "book": pl.String, "label": pl.String,
    "token": pl.String, "qty": pl.Float64, "usd": pl.Float64, "ts": pl.Int64,
    "cat": pl.String, "quote": pl.String})


def _read_swaps(paths, columns: list[str], what: str) -> pl.DataFrame:
    paths = list(paths)
    if not paths:
        raise SystemExit(f"no {what} tape on disk")
    try:
        return pl.concat([pl.read_parquet(p, columns=columns) for p in paths])
    except pl.exceptions.ColumnNotFoundError as exc:
        raise SystemExit(f"{what} tape is missing a column the fold needs: {exc}") from exc


def rwa(root: Path, source: str = "edge") -> pl.DataFrame:
    suffix = "" if source == "public" else f"_{source}"
    swaps = _read_swaps(sorted((INGEST / "swaps_tx").glob("part-*.parquet")),
                        RWA_COLUMNS, "RWA swap")
    parts = sorted((INGEST / f"tx_from{suffix}").glob("part-*.parquet"))
    if not parts:
        raise SystemExit(f"no resolved transactions for source '{source}'")
    senders = pl.concat([pl.read_parquet(p) for p in parts]).unique(subset=["tx_hash"])
    pools = _pools()
    tok = _tokens()
    t0 = tok.select(pl.col("address").alias("currency0"), pl.col("symbol").alias("s0"),
                    pl.col("decimals").alias("d0"), pl.col("kind").alias("k0"))
    t1 = tok.select(pl.col("address").alias("currency1"), pl.col("symbol").alias("s1"),
                    pl.col("decimals").alias("d1"), pl.col("kind").alias("k1"))
    meta = (pools.join(t0, on="currency0", how="left").join(t1, on="currency1", how="left")
            .with_columns(rwa0=(pl.col("k0") == "rwa_spot"),
                          ticker=pl.when(pl.col("k0") == "rwa_spot")
                                   .then(pl.col("s0")).otherwise(pl.col("s1")))
            .filter((pl.col("k0") == "rwa_spot") | (pl.col("k1") == "rwa_spot"))
            .select("pool_id", "ticker", "rwa0", "d0", "d1"))
    df = swaps.join(meta, on="pool_id", how="inner").join(senders, on="tx_hash", how="inner")
    bn, bts = _block_times(root)
    ts = np.interp(df["block"].to_numpy().astype(np.int64), bn, bts).astype(np.int64)
    d0 = df["d0"].fill_null(18).to_numpy()
    d1 = df["d1"].fill_null(18).to_numpy()
    r0 = df["rwa0"].to_numpy()
    a0 = np.array([float(int(x)) for x in df["amount0"].to_list()])
    a1 = np.array([float(int(x)) for x in df["amount1"].to_list()])
    qty = -np.where(r0, a0 / 10.0 ** d0, a1 / 10.0 ** d1)
    usd = -np.where(r0, a1 / 10.0 ** d1, a0 / 10.0 ** d0)
    sp = df["sqrt_price_x96"].cast(pl.Float64).to_numpy()
    p10 = (sp / Q96) ** 2 * (10.0 ** (d0 - d1))
    with np.errstate(divide="ignore", invalid="ignore"):
        px = np.where(r0, p10, np.where(p10 > 0, 1.0 / p10, np.nan))
    ok = np.isfinite(px) & (px > 0.01) & (px < 1e5)
    return (df.with_columns(qty=pl.Series(qty), usd=pl.Series(usd), ts=pl.Series(ts),
                            ok=pl.Series(ok))
            .filter(pl.col("ok"))
            .select(tx="tx_hash", addr="tx_from", book="ticker", label="ticker",
                    token=pl.lit(""), qty="qty", usd="usd", ts="ts",
                    cat=pl.lit("rwa"), quote=pl.lit("USDG")))


def pons(root: Path, source: str = "edge") -> pl.DataFrame:
    from registry import basket as pons_basket  # noqa: PLC0415
    ids = [t["pair"] for t in pons_basket()["tokens"] if t.get("pair")]
    pools = _pools()
    sym = _symbols(root)
    dec = _decimals(root)
    universe = {}
    for r in pools.filter(pl.col("pool_id").is_in(ids)).iter_rows(named=True):
        s0, s1 = sym.get(r["currency0"]), sym.get(r["currency1"])
        if s0 in QUOTES:
            side, quote, base = 0, s0, r["currency1"]
        elif s1 in QUOTES:
            side, quote, base = 1, s1, r["currency0"]
        else:
            continue
        universe[r["pool_id"]] = {
            "side": side, "quote": quote, "qdec": QUOTES[quote],
            "label": sym.get(base) or base[:10], "addr": base, "bdec": dec.get(base)}

    # An empty Pons tape returns an empty frame rather than stopping the build, so the
    # refusal comes from the gates and names what is wrong instead of arriving as a stack
    # trace from the fold. It is not waved through: every Pons scope then builds nothing in
    # any window and the "every declared scope produced a ranking" gate refuses. That gate
    # exists because of this branch — the empty scopes were not left empty, they vanished
    # from the view list entirely, and every gate that compares against a previous build is
    # skipped on a first build, which is exactly when a universe goes missing.
    tape = sorted((INGEST / "pons_swaps").glob("part-*.parquet"))
    if not tape:
        print("no Pons tape on disk; the Pons scopes will be empty and the gates will "
              "refuse the build")
        return EMPTY_TRADES
    swaps = _read_swaps(tape, BASE_COLUMNS, "Pons swap")
    # The identity resolver covers both tapes into one table. tx_from_pons is the older
    # split output and is still read where it exists, so a volume carrying one does not
    # have to re-resolve transactions it already knows.
    suffix = "" if source == "public" else f"_{source}"
    parts = sorted((INGEST / f"tx_from{suffix}").glob("part-*.parquet")) + \
        sorted((INGEST / "tx_from_pons").glob("part-*.parquet"))
    if not parts:
        raise SystemExit("no resolved transactions for the Pons tape")
    senders = (pl.concat([pl.read_parquet(p, columns=["tx_hash", "tx_from"]) for p in parts])
               .unique(subset=["tx_hash"]))
    df = swaps.join(senders, on="tx_hash", how="inner").filter(
        pl.col("pool_id").is_in(list(universe)))
    bn, bts = _block_times(root)
    ts = np.interp(df["block"].to_numpy().astype(np.int64), bn, bts).astype(np.int64)
    ids_ = df["pool_id"].to_list()
    a0 = np.array([float(int(x)) for x in df["amount0"].to_list()])
    a1 = np.array([float(int(x)) for x in df["amount1"].to_list()])
    side = np.array([universe[p]["side"] for p in ids_])
    qdec = np.array([universe[p]["qdec"] for p in ids_])
    # Decimals read from the contract where the registry had none. A token that would not
    # answer is dropped rather than defaulted to 18: an 18 that is really a 6 is a
    # trillion-fold error in a displayed quantity and it looks entirely plausible.
    bdec = np.array([universe[p]["bdec"] if universe[p]["bdec"] is not None else -1
                     for p in ids_])
    quote = np.array([universe[p]["quote"] for p in ids_])
    label = [universe[p]["label"] for p in ids_]
    taddr = [universe[p]["addr"] for p in ids_]
    qty = -np.where(side == 0, a1, a0) / (10.0 ** np.where(bdec >= 0, bdec, 0))
    q = -np.where(side == 0, a0, a1) / (10.0 ** qdec)
    eth_ts, eth_px = eth_usd_series()
    usd = q * np.where(quote == "ETH", np.interp(ts, eth_ts, eth_px), 1.0)
    return (pl.DataFrame({"tx": df["tx_hash"], "addr": df["tx_from"],
                          "book": df["pool_id"], "label": label, "token": taddr,
                          "qty": qty, "usd": usd,
                          "ts": ts, "cat": "pons", "quote": quote,
                          "known_dec": bdec >= 0})
            .filter(pl.col("known_dec")).drop("known_dec"))


def netted(df: pl.DataFrame) -> pl.DataFrame:
    """Legs are not trades: one position change per (transaction, book)."""
    return (df.group_by(["tx", "addr", "book", "label", "token", "cat", "quote"])
            .agg(pl.col("qty").sum(), pl.col("usd").sum(), pl.col("ts").min())
            .filter(pl.col("qty").abs() > DUST)
            .sort("ts"))


def combined(root: Path, source: str = "edge") -> pl.DataFrame:
    return netted(pl.concat([rwa(root, source), pons(root, source)],
                            how="vertical_relaxed"))


SCOPES = [
    {"id": "all", "cat": None, "quote": None, "label": "All"},
    {"id": "rwa", "cat": "rwa", "quote": None, "label": "RWA"},
    {"id": "pons", "cat": "pons", "quote": None, "label": "Pons"},
    {"id": "all-usdg", "cat": None, "quote": "USDG", "label": "All · USDG"},
    {"id": "all-eth", "cat": None, "quote": "ETH", "label": "All · ETH"},
    {"id": "pons-usdg", "cat": "pons", "quote": "USDG", "label": "Pons · USDG"},
    {"id": "pons-eth", "cat": "pons", "quote": "ETH", "label": "Pons · ETH"},
]


def apply_scope(trades: pl.DataFrame, scope: dict) -> pl.DataFrame:
    out = trades
    if scope["cat"]:
        out = out.filter(pl.col("cat") == scope["cat"])
    if scope["quote"]:
        out = out.filter(pl.col("quote") == scope["quote"])
    return out
