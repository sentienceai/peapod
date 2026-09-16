"""An ETH/USD series derived from this chain, so the ETH cohort can share a table with USDG.

WHY NOT AN OUTSIDE FEED. Half the Pons pools quote in native ETH and half in USDG, and
without a price the two cohorts cannot be added together or ranked against each other. A
bought feed would put an off-chain price series against on-chain trades whose timestamps
are already interpolated from block_times, and the alignment error would land straight in
someone's PnL. This chain has 513 ETH/USDG pools and USDG is the same dollar the RWA
leaderboard already denominates in, so the price is on the tape at trade granularity, for
the same blocks, with no alignment step at all.

HOW THE REFERENCE POOL IS CHOSEN. A thin pool's spot price is noisy and cheap to push, and
a five-second excursion in the reference would be a permanent error in every trade priced
against it. So pools are ranked by executable depth, not by how often they trade.

FLAT-L IS USED FOR SELECTION ONLY. Executable depth needs the tick map, which needs a
ModifyLiquidity ingest per pool. For CHOOSING between candidates that differ by orders of
magnitude, the flat-liquidity estimate off each Swap's own sqrtPriceX96 and liquidity is
more than enough, and it costs no extra ingest. It is not published as a depth figure
anywhere: this project has already measured that flat-L errs in both directions (p5 69%,
p95 116% of executable), which is fatal for a headline number and irrelevant for an
argmax over pools that differ by 100x.

THE CROSS-CHECK IS THE POINT. An on-chain price that tracks the outside world is sound. An
on-chain price that does not is itself a finding about this chain, and either way it has to
be reported rather than assumed, so the derived series is compared against CoinGecko's
hourly ETH/USD over the same window and the divergence is published.

Usage:  uv run python ingest/eth_usd.py --stage select|series|check
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from settings import env

import polars as pl
import requests

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "export"))
OUT = HERE / "out" / "eth_usd"
SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"
NATIVE = "0x0000000000000000000000000000000000000000"
WIDTH = 20_000          # Edge refuses 30,000 whatever the filter; 20,000 is served.
USDG_DECIMALS = 6
ETH_DECIMALS = 18
# The chosen reference pool, vendored beside the rest of the registry.
#
# WHY VENDORED RATHER THAN RECOMPUTED. Choosing the pool is an argmax over executable depth
# across every ETH/USDG pool on the chain. It is expensive, it needs the band arithmetic,
# and it is not guaranteed to return the same pool twice as depth moves. Running it on a
# fifteen-minute schedule would let the reference flip mid-series, which puts a step change
# into every ETH-quoted PnL on the site for no reason anyone could see. The selection is a
# decision; --stage select is how it is revisited, deliberately.
SELECTION = HERE.parent / "registry" / "eth-usd-reference.json"


def selection() -> dict | None:
    """The reference pool and its runners-up, from this run's own select or the vendored copy."""
    if (OUT / "reference.json").exists() and (OUT / "candidates.json").exists():
        return {"reference": json.loads((OUT / "reference.json").read_text()),
                "candidates": json.loads((OUT / "candidates.json").read_text())}
    if SELECTION.exists():
        return json.loads(SELECTION.read_text())
    return None




def rpc(url, method, params, session=requests):
    r = session.post(url, json={"jsonrpc": "2.0", "id": 1, "method": method,
                               "params": params}, timeout=180)
    r.raise_for_status()
    body = r.json()
    if "error" in body:
        raise RuntimeError(f"{method}: {body['error']}")
    return body["result"]


def word(data: str, i: int) -> int:
    return int(data[2 + i * 64: 66 + i * 64], 16)


def signed(v: int, bits: int = 256) -> int:
    """ABI words are sign-extended to 256 bits; reading int128 at its declared width
    turns every negative amount into an enormous positive one."""
    return v - (1 << bits) if v >= (1 << (bits - 1)) else v


def decode_swap(log: dict) -> dict:
    d = log["data"]
    return {
        "pool_id": log["topics"][1],
        "block": int(log["blockNumber"], 16),
        "log_index": int(log["logIndex"], 16),
        "amount0": signed(word(d, 0)),
        "amount1": signed(word(d, 1)),
        "sqrt_price": word(d, 2),
        "liquidity": word(d, 3),
        "tick": signed(word(d, 4)),
    }


def candidates(root: Path) -> tuple[list[str], dict[str, dict]]:
    """Every pool pairing native ETH with USDG, and which side ETH is on."""
    from registry import pools as _pools, tokens as _tokens  # noqa: PLC0415
    pools = _pools()
    tok = _tokens()
    usdg = {r["address"] for r in tok.iter_rows(named=True) if r["symbol"] == "USDG"}
    meta: dict[str, dict] = {}
    for r in pools.iter_rows(named=True):
        c0, c1 = r["currency0"], r["currency1"]
        if c0 == NATIVE and c1 in usdg:
            meta[r["pool_id"]] = {"eth0": True, "fee": r.get("fee"), "pool_id": r["pool_id"]}
        elif c1 == NATIVE and c0 in usdg:
            meta[r["pool_id"]] = {"eth0": False, "fee": r.get("fee"), "pool_id": r["pool_id"]}
    return list(meta), meta


def price_from(sqrt_price: int, eth0: bool) -> float:
    """USDG per ETH.

    (sqrtP / 2^96)^2 is token1 per token0 in raw units. Decimals are then undone. Which
    token is which depends on sort order, so the reciprocal is taken when ETH is token1.
    """
    ratio = (sqrt_price / (1 << 96)) ** 2
    if eth0:
        return ratio * 10 ** (ETH_DECIMALS - USDG_DECIMALS)
    if ratio == 0:
        return 0.0
    return (1 / ratio) * 10 ** (ETH_DECIMALS - USDG_DECIMALS)


def fetch_swaps(url: str, pool_ids: list[str], lo: int, hi: int, session) -> list[dict]:
    out = []
    for start in range(lo, hi + 1, WIDTH):
        stop = min(start + WIDTH - 1, hi)
        for attempt in range(5):
            try:
                logs = rpc(url, "eth_getLogs", [{
                    "fromBlock": hex(start), "toBlock": hex(stop),
                    "topics": [SWAP_TOPIC, pool_ids]}], session)
                out.extend(decode_swap(x) for x in logs)
                break
            except Exception:
                if attempt == 4:
                    raise
                time.sleep(2 ** attempt)
    return out


def stage_select(url: str, root: Path, lo: int, hi: int) -> None:
    ids, meta = candidates(root)
    print(f"{len(ids):,} ETH/USDG pools in the registry", flush=True)
    session = requests.Session()

    # A recent slice is enough to find which pools are alive at all; depth is then
    # measured at the last swap each one actually had in it.
    probe_lo = max(lo, hi - 400_000)
    swaps = fetch_swaps(url, ids, probe_lo, hi, session)
    print(f"{len(swaps):,} swaps across them in the last {hi - probe_lo:,} blocks", flush=True)
    if not swaps:
        raise SystemExit("no ETH/USDG swaps in the probe window")

    from bandwalk import flat_band_depth  # noqa: PLC0415

    last: dict[str, dict] = {}
    counts: dict[str, int] = {}
    for s in swaps:
        counts[s["pool_id"]] = counts.get(s["pool_id"], 0) + 1
        prev = last.get(s["pool_id"])
        if prev is None or (s["block"], s["log_index"]) > (prev["block"], prev["log_index"]):
            last[s["pool_id"]] = s

    rows = []
    for pid, s in last.items():
        m = meta[pid]
        px = price_from(s["sqrt_price"], m["eth0"])
        if px <= 0 or s["liquidity"] == 0:
            continue
        d0, d1 = (ETH_DECIMALS, USDG_DECIMALS) if m["eth0"] else (USDG_DECIMALS, ETH_DECIMALS)
        depth = flat_band_depth(_LM, s["sqrt_price"], s["liquidity"], d0, d1, m["eth0"], px)
        rows.append({"pool_id": pid, "eth0": m["eth0"], "fee": m["fee"],
                     "swaps": counts[pid], "price": px, "depth_usd": depth,
                     "block": s["block"]})
    rows.sort(key=lambda r: -r["depth_usd"])
    (OUT / "candidates.json").write_text(json.dumps(rows[:40], indent=1))
    print(f"\n{'pool':<12}{'fee':>8}{'swaps':>9}{'+/-1% depth':>16}{'price':>12}")
    for r in rows[:8]:
        print(f"  {r['pool_id'][:10]}{str(r['fee']):>8}{r['swaps']:>9,}"
              f"{r['depth_usd']:>15,.0f}{r['price']:>12,.2f}")
    top = rows[0]
    share = top["depth_usd"] / sum(r["depth_usd"] for r in rows)
    print(f"\ndeepest: {top['pool_id']}  ${top['depth_usd']:,.0f} at +/-1%, "
          f"{share:.1%} of all ETH/USDG depth, {top['swaps']:,} swaps in the probe window")
    (OUT / "reference.json").write_text(json.dumps(top, indent=1))
    # Vendored too, so a container that has never run this stage still knows which pool
    # the price series is read from.
    SELECTION.parent.mkdir(parents=True, exist_ok=True)
    SELECTION.write_text(json.dumps(
        {"reference": top, "candidates": json.loads((OUT / "candidates.json").read_text())},
        indent=1))


def stage_series(url: str, root: Path, lo: int, hi: int) -> None:
    """Every swap in the reference pool, as a price at a block."""
    chosen = selection()
    ref, cands = chosen["reference"], chosen["candidates"]
    second = next(c for c in cands if c["pool_id"] != ref["pool_id"])
    session = requests.Session()

    # NAMED, TYPED COLUMNS EVEN WHEN THERE ARE NO ROWS. pl.DataFrame([]) has no columns at
    # all, so the .unique(subset=[...]) below raised `unable to find column "block"` rather
    # than producing an empty frame. A window with no swaps in it is not an error and it is
    # not rare: the cross-check pool trades far less than the reference, and a cold volume
    # prices whatever narrow window the Pons tape covers on its first tick.
    schema = {"block": pl.Int64, "log_index": pl.Int64, "sqrt_price": pl.String,
              "liquidity": pl.String, "price": pl.Float64}
    for tag, pool in (("reference", ref), ("second", second)):
        swaps = fetch_swaps(url, [pool["pool_id"]], lo, hi, session)
        rows = [{"block": s["block"], "log_index": s["log_index"],
                 "sqrt_price": str(s["sqrt_price"]), "liquidity": str(s["liquidity"]),
                 "price": price_from(s["sqrt_price"], pool["eth0"])}
                for s in swaps if s["sqrt_price"] > 0]
        df = (pl.DataFrame(rows, schema=schema).unique(subset=["block", "log_index"])
              .sort(["block", "log_index"]))
        df.write_parquet(OUT / f"{tag}.parquet")
        print(f"{tag} {pool['pool_id'][:10]}: {df.height:,} priced swaps", flush=True)

    from registry import block_times  # noqa: PLC0415
    bt = block_times().sort("block")
    import numpy as np  # noqa: PLC0415
    df = pl.read_parquet(OUT / "reference.parquet")
    # Two observations is the minimum that makes a series: one interval to describe, and
    # something to interpolate between. Below that the arithmetic underneath the summary is
    # all on empty arrays — np.diff of one row, then .max() of nothing. There is no build
    # to protect here either way: the "eth series is present and moving" gate wants over a
    # thousand points, so a short window is refused with a figure rather than a traceback.
    if df.height < 2:
        print(f"only {df.height} priced swap(s) in the reference pool over "
              f"{lo:,}..{hi:,}; too short to make a series, so none is written")
        return
    ts = np.interp(df["block"].to_numpy().astype(np.int64),
                   bt["block"].to_numpy().astype(np.int64),
                   bt["ts"].to_numpy().astype(np.int64)).astype(np.int64)
    df = df.with_columns(ts=pl.Series(ts)).sort("ts")
    df.write_parquet(OUT / "series.parquet")

    gaps = np.diff(df["ts"].to_numpy())
    px = df["price"].to_numpy()
    print(f"\nseries: {df.height:,} observations over "
          f"{(ts.max() - ts.min()) / 86400:.1f} days")
    print(f"  price ${px.min():,.2f} .. ${px.max():,.2f}, median ${np.median(px):,.2f}")
    print("  gaps between observations (seconds): "
          f"p50 {np.percentile(gaps, 50):.0f}  p95 {np.percentile(gaps, 95):.0f}  "
          f"p99 {np.percentile(gaps, 99):.0f}  max {gaps.max():,.0f}")
    print(f"  observations more than 10 minutes apart: {(gaps > 600).sum():,} "
          f"({(gaps > 600).mean():.2%})")


def stage_check(root: Path) -> None:
    """Against the second-deepest pool, and against an outside feed."""
    import numpy as np  # noqa: PLC0415
    ref = pl.read_parquet(OUT / "series.parquet")
    lo_ts, hi_ts = int(ref["ts"].min()), int(ref["ts"].max())

    # 1. A second, independent pool on the same chain. If two pools that share no
    #    liquidity disagree, the reference is being pushed around and is not usable.
    from registry import block_times  # noqa: PLC0415
    bt = block_times().sort("block")
    sec = pl.read_parquet(OUT / "second.parquet")
    sts = np.interp(sec["block"].to_numpy().astype(np.int64),
                    bt["block"].to_numpy().astype(np.int64),
                    bt["ts"].to_numpy().astype(np.int64)).astype(np.int64)
    at_ref = np.interp(sts, ref["ts"].to_numpy(), ref["price"].to_numpy())
    rel = np.abs(sec["price"].to_numpy() - at_ref) / at_ref * 100
    print(f"vs the second-deepest pool ({sec.height:,} points): "
          f"median {np.median(rel):.3f}%  p95 {np.percentile(rel, 95):.3f}%  "
          f"max {rel.max():.2f}%")

    # 2. An outside feed. Hourly is all the free tier gives and all this needs: the
    #    question is whether the chain tracks the world, not whether it leads it by a
    #    block.
    url = ("https://api.coingecko.com/api/v3/coins/ethereum/market_chart/range"
           f"?vs_currency=usd&from={lo_ts}&to={hi_ts}")
    try:
        r = requests.get(url, timeout=60, headers={"accept": "application/json"})
        body = r.json() if r.status_code == 200 else None
        points = (body or {}).get("prices") or []
    except Exception as exc:                       # noqa: BLE001
        points, body = [], {"error": str(exc)}
    if not points:
        print(f"coingecko returned no points ({str(body)[:160]}); "
              "the on-chain cross-check above stands alone and this is recorded as a gap")
        (OUT / "crosscheck.json").write_text(json.dumps(
            {"second_pool_median_pct": float(np.median(rel)),
             "second_pool_max_pct": float(rel.max()),
             "coingecko": "unavailable"}, indent=1))
        return
    cg_ts = np.array([p[0] / 1000 for p in points])
    cg_px = np.array([p[1] for p in points])
    ours = np.interp(cg_ts, ref["ts"].to_numpy(), ref["price"].to_numpy())
    inside = (cg_ts >= lo_ts) & (cg_ts <= hi_ts)
    d = np.abs(ours[inside] - cg_px[inside]) / cg_px[inside] * 100
    print(f"vs coingecko hourly ({inside.sum()} points): median {np.median(d):.2f}%  "
          f"p95 {np.percentile(d, 95):.2f}%  max {d.max():.2f}%")
    (OUT / "crosscheck.json").write_text(json.dumps(
        {"second_pool_median_pct": float(np.median(rel)),
         "second_pool_max_pct": float(rel.max()),
         "coingecko_points": int(inside.sum()),
         "coingecko_median_pct": float(np.median(d)),
         "coingecko_max_pct": float(d.max())}, indent=1))


_LM = None


def main() -> int:
    global _LM
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", required=True, choices=["select", "series", "check"])
    args = ap.parse_args()
    root = Path(os.environ.get("PEAPOD_LP_TERMINAL") or HERE.parent).expanduser()
    # The band arithmetic is vendored in engine/. It is only needed to CHOOSE the
    # reference pool, so it is imported for that stage alone — importing it for every
    # stage is what made a container fail on `--stage series`, which never touches it.
    # EVERY STAGE CREATES ITS OWN OUTPUT DIRECTORY. This mkdir lived in --stage select
    # alone, so --stage series — the one the cycle runs — fetched the reference pool's
    # swaps over the network and then died writing them:
    #
    #   FileNotFoundError: No such file or directory (os error 2):
    #     /app/ingest/out/eth_usd/reference.parquet
    #
    # Vendoring the selection fixed the READ this stage does and left the WRITE, which is
    # the same cold-volume assumption one line further down.
    OUT.mkdir(parents=True, exist_ok=True)
    if args.stage == "select":
        sys.path.insert(0, str(HERE.parent / "engine"))
        import importlib  # noqa: PLC0415
        _LM = importlib.import_module("liquidity_math")
    url = env()["GOLDSKY_EDGE_URL"]
    # The window to price is the Pons tape's own extent, so this stage has nothing to do
    # until the Pons ingest has fetched something. On a cold volume that was
    # `cannot concat empty list` from a bare concat over an empty directory — a crash
    # describing the code rather than the situation. Skipping is correct here: an unpriced
    # ETH cohort cannot rank, and the empty Pons scopes are refused by the gates, so
    # nothing is published on the strength of a missing price series.
    parts = sorted((HERE / "out" / "pons_swaps").rglob("*.parquet"))
    if not parts:
        print("no Pons tape yet, so no window to price; skipping")
        return 0
    swaps = pl.concat([pl.read_parquet(p, columns=["block"]) for p in parts])
    lo, hi = int(swaps["block"].min()), int(swaps["block"].max())
    print(f"pons window: blocks {lo:,}..{hi:,}")
    if args.stage != "select" and selection() is None:
        print(f"no reference pool chosen and none vendored at {SELECTION}; "
              "run --stage select; skipping")
        return 0
    if args.stage == "select":
        stage_select(url, root, lo, hi)
    elif args.stage == "series":
        stage_series(url, root, lo, hi)
    else:
        stage_check(root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
