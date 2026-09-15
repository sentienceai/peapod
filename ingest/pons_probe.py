"""Measure round-trip PnL magnitudes on the Pons universe, for comparison with the RWA run.

THE QUESTION. The RWA round-trip leaderboard's top address made $65 over 23 hours. Is that
a property of tokenized equities, or of this chain? Pons carries roughly 18x the daily flow,
so the answer changes what v1 should cover.

DENOMINATED IN THE QUOTE ASSET, NOT USD. Half the Pons pools quote in native ETH, and a
USD figure would need an ETH price series at trade granularity that we do not have. Rather
than invent one, PnL is reported in whatever each pool quotes in, and the ETH and USDG
cohorts are reported separately. A single spot rate is applied at the very end for a rough
cross-read only, and labelled as such.

WHY UNKNOWN DECIMALS DO NOT MATTER HERE. The token registry has no decimals for 60 of the
90 Pons pools, because it was built for tokenized equities. It does not matter for PnL:
quantity scales by 10^-k and price by 10^+k, so their product is unchanged. Matching is done
in raw base units, which is self-consistent per address and token. Only the QUOTE side's
decimals need to be right, and those are known (ETH 18, USDG 6).

Usage:  PEAPOD_LP_TERMINAL=~/lp-terminal PYTHONPATH=ingest:export \
          uv run python ingest/pons_probe.py --stage ingest|resolve|report
"""

from __future__ import annotations

import argparse
import json
import os
import time
from collections import defaultdict, deque
from pathlib import Path

import numpy as np
import polars as pl
import requests

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
PONS_SWAPS = OUT / "pons_swaps"
PONS_FROM = OUT / "tx_from_pons"
PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"
BASKET = Path("/Users/sentientai/canopy/data/pons-basket.json")
DUST = 1e-12

# Quote assets we can denominate in without a price series.
QUOTES = {"ETH": 18, "USDG": 6}

# Measured against Edge: a 30,000-block range returns logs, 50,000 returns error -32012
# inside a 200. Stay well under it, and never widen past what was measured to work.
MIN_WIDTH, MAX_WIDTH = 500, 25_000


def env() -> dict:
    values = {}
    path = HERE.parent / ".env"
    for line in path.read_text().splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, _, v = line.partition("=")
            values[k.strip()] = v.strip().strip("'\"")
    return values


def signed(value: int) -> int:
    return value - (1 << 256) if value >= (1 << 255) else value


def word(data: str, i: int) -> int:
    raw = data[2:] if data.startswith("0x") else data
    return int(raw[i * 64:(i + 1) * 64], 16)


def pool_universe(root: Path):
    """Pons pools whose quote side we can denominate in, with the quote's side and decimals."""
    basket = json.loads(BASKET.read_text())
    ids = [t["pair"] for t in basket["tokens"] if t.get("pair")]
    pools = pl.concat([pl.read_parquet(p)
                       for p in sorted((root / "out" / "raw" / "pools").glob("part-*.parquet"))])
    tok = pl.read_parquet(root / "out" / "raw" / "tokens" / "part-00000.parquet")
    sym = dict(zip(tok["address"].to_list(), tok["symbol"].to_list()))
    have = pools.filter(pl.col("pool_id").is_in(ids))
    universe = {}
    for r in have.iter_rows(named=True):
        s0, s1 = sym.get(r["currency0"]), sym.get(r["currency1"])
        if s0 in QUOTES:
            universe[r["pool_id"]] = {"quote_side": 0, "quote": s0, "qdec": QUOTES[s0]}
        elif s1 in QUOTES:
            universe[r["pool_id"]] = {"quote_side": 1, "quote": s1, "qdec": QUOTES[s1]}
    return universe


def stage_ingest(root: Path, days: float):
    universe = pool_universe(root)
    ids = sorted(universe)
    print(f"pons pools with a denominable quote: {len(ids)} "
          f"({sum(1 for v in universe.values() if v['quote'] == 'ETH')} ETH, "
          f"{sum(1 for v in universe.values() if v['quote'] == 'USDG')} USDG)")
    bt = pl.read_parquet(root / "out" / "block_times.parquet").sort("block")
    bn = bt["block"].to_numpy().astype(np.int64)
    bts = bt["ts"].to_numpy().astype(np.int64)
    end_block = int(bn.max())
    end_ts = float(bts.max())
    start_block = int(np.interp(end_ts - days * 86400, bts, bn))
    print(f"window: blocks {start_block:,}..{end_block:,} ({days} days)")

    url = env()["GOLDSKY_EDGE_URL"]
    session = requests.Session()
    PONS_SWAPS.mkdir(parents=True, exist_ok=True)
    rows, part, cursor, width = [], 0, start_block, MAX_WIDTH
    began = time.time()
    while cursor <= end_block:
        hi = min(cursor + width - 1, end_block)
        params = {"fromBlock": hex(cursor), "toBlock": hex(hi), "address": PM,
                  "topics": [SWAP, ids]}
        r = session.post(url, json={"jsonrpc": "2.0", "id": 1, "method": "eth_getLogs",
                                    "params": [params]}, timeout=180)
        body = r.json() if r.status_code == 200 else {}
        # A JSON-RPC error arrives inside a 200. Reading .get("result", []) here treats
        # "your range was too wide" as "there is nothing in this range" and advances the
        # cursor over real data. The status code is not the answer; the payload is.
        if r.status_code != 200 or "error" in body or "result" not in body:
            time.sleep(1.5)
            if width <= MIN_WIDTH:
                raise SystemExit(f"cannot shrink below {MIN_WIDTH} at block {cursor}: "
                                 f"{str(body.get('error'))[:160]}")
            width = max(MIN_WIDTH, width // 2)
            continue
        logs = body["result"]
        for lg in logs:
            data = lg["data"]
            rows.append({"pool_id": lg["topics"][1], "block": int(lg["blockNumber"], 16),
                         "log_index": int(lg["logIndex"], 16), "tx_hash": lg["transactionHash"],
                         "block_hash": lg.get("blockHash"), "removed": bool(lg.get("removed")),
                         "amount0": str(signed(word(data, 0))),
                         "amount1": str(signed(word(data, 1))),
                         "fee": word(data, 5)})
        cursor = hi + 1
        if len(logs) > 15_000:
            width = max(MIN_WIDTH, width // 2)
        elif len(logs) < 3_000:
            width = min(MAX_WIDTH, int(width * 1.5))
        if len(rows) >= 200_000:
            pl.DataFrame(rows).write_parquet(PONS_SWAPS / f"part-{part:05d}.parquet")
            part += 1
            print(f"  block {cursor:,}  rows {part * 200_000:,}  {time.time()-began:.0f}s", flush=True)
            rows = []
        time.sleep(0.4)
    if rows:
        pl.DataFrame(rows).write_parquet(PONS_SWAPS / f"part-{part:05d}.parquet")
    total = sum(len(pl.read_parquet(p)) for p in PONS_SWAPS.glob("part-*.parquet"))
    print(f"\npons swaps in window: {total:,} in {(time.time()-began)/60:.1f} min")
    blocks = set()
    for p in PONS_SWAPS.glob("part-*.parquet"):
        blocks.update(pl.read_parquet(p)["block"].to_list())
    print(f"distinct blocks to resolve: {len(blocks):,}")
    (OUT / "pons_blocks.json").write_text(json.dumps(sorted(blocks)))

    # Verify by resampling: re-query narrow windows and check the captured count matches.
    # An ingest that silently skipped a range looks identical to one that found nothing.
    captured = pl.concat([pl.read_parquet(p) for p in PONS_SWAPS.glob("part-*.parquet")])
    rng = np.random.default_rng(11)
    print("\nverification — re-querying random 5,000-block windows:")
    bad = 0
    for _ in range(6):
        s0 = int(rng.integers(start_block, end_block - 5_000))
        params = {"fromBlock": hex(s0), "toBlock": hex(s0 + 4_999), "address": PM,
                  "topics": [SWAP, ids]}
        rr = session.post(url, json={"jsonrpc": "2.0", "id": 1, "method": "eth_getLogs",
                                     "params": [params]}, timeout=180).json()
        if "result" not in rr:
            print(f"  {s0:,}: query error, skipped")
            continue
        expect = len(rr["result"])
        got = captured.filter((pl.col("block") >= s0) & (pl.col("block") <= s0 + 4_999)).height
        ok = expect == got
        bad += not ok
        print(f"  {s0:,}..+5,000  chain={expect:>6,}  captured={got:>6,}  {'ok' if ok else 'MISMATCH'}")
        time.sleep(1.0)
    print("  verification:", "passed" if bad == 0 else f"FAILED on {bad} of 6 windows")


def main() -> int:
    import sys
    sys.path.insert(0, str(HERE.parent / "export"))
    from upstream import lp_terminal  # noqa: PLC0415
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="ingest", choices=["ingest", "resolve", "report"])
    ap.add_argument("--days", type=float, default=7.0)
    args = ap.parse_args()
    root = lp_terminal()
    if args.stage == "ingest":
        stage_ingest(root, args.days)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
