"""How many distinct addresses does an RWA transfer index actually touch?

THE QUESTION. peapod ships one JSON file per address. That model works at 53,222
addresses (the swap universe). It does not work at low millions. A transfer index
touches every address that ever held a tokenized equity, not just those that traded
one, and that set has never been measured. If it is millions, the file-per-address
model has to be replaced before any of the index is built, not after.

WHY SAMPLING. The full index is ~200M events and hours of fetching. To answer a
question whose useful precision is "hundreds of thousands or millions", that is absurd.
So: sample block ranges spread over the chain and count the distinct addresses in them.

COUNT EXACTLY, NOT WITH A SKETCH. An earlier version of this used a modulo sketch to
keep memory flat, on the assumption that the address set was too large to hold. It is
not: a million 40-character addresses is about 90 MB in a set, and the machine has it.
The sketch also produced two estimates 8 sigma apart, which cost more time to
investigate than the exact count costs to run. The two sketches are still computed and
reported alongside the exact figure, because their agreement or divergence against a
known-true number is the evidence for whether address bytes are uniform on this chain.

SHUFFLED FETCH ORDER. The rarefaction curve -- distinct as a function of events read --
is only meaningful if the chunks arrive in random order; walking the chain start to end
would make the curve a picture of the chain's history rather than of address recurrence.
So the ranges covering the whole chain are shuffled once, with a fixed seed, and fetched
in that order. The curve is then read directly off the running count.

WHAT THE SAMPLE CANNOT DO. A sample sees a fraction of events and therefore a fraction
of addresses, and scaling the sample's distinct count by the inverse sampling fraction
would be wrong in the obvious direction: addresses recur, so distinct count grows
sublinearly in events. The rarefaction curve -- distinct as a function of events read,
computed by permuting the sampled chunks -- is what says whether the curve has flattened
and what the total extrapolates to. Both the curve and the extrapolation are reported.

Usage:  uv run python ingest/transfer_cardinality.py --minutes 20
"""

from __future__ import annotations

import argparse
import json
import random
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from itertools import islice
from pathlib import Path

from settings import env

import polars as pl
import requests

HERE = Path(__file__).resolve().parent
OUT = HERE / "out" / "transfer_cardinality.json"
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
CHUNK = 5_000
MOD = 256




def rpc(url: str, method: str, params: list, session: requests.Session):
    """Raise on a JSON-RPC error even though the HTTP status is 200.

    Edge answers an over-wide range with HTTP 200 and error -32012. Reading
    .get("result", []) off that turns a refusal into "no logs here", which is
    how a 1,310,815-swap tape was once reported as 440 swaps.
    """
    r = session.post(url, json={"jsonrpc": "2.0", "id": 1, "method": method,
                               "params": params}, timeout=180)
    r.raise_for_status()
    body = r.json()
    if "error" in body:
        raise RuntimeError(f"{method}: {body['error']}")
    return body["result"]


def fetch_chunk(url: str, tokens: list[str], lo: int, hi: int, session: requests.Session):
    """Return logs for [lo, hi], halving the range if the provider refuses its width."""
    try:
        return rpc(url, "eth_getLogs", [{"fromBlock": hex(lo), "toBlock": hex(hi),
                                        "address": tokens, "topics": [TRANSFER]}], session)
    except RuntimeError:
        if hi <= lo:
            raise
        mid = (lo + hi) // 2
        return (fetch_chunk(url, tokens, lo, mid, session)
                + fetch_chunk(url, tokens, mid + 1, hi, session))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=float, default=20.0)
    ap.add_argument("--anchors", type=int, default=96)
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    url = env()["GOLDSKY_EDGE_URL"]
    session = requests.Session()
    root = Path.home() / "lp-terminal"
    tok = pl.read_parquet(root / "out" / "raw" / "tokens" / "part-00000.parquet")
    tokens = tok.filter(pl.col("kind") == "rwa_spot")["address"].to_list()

    head = int(rpc(url, "eth_blockNumber", [], session), 16)
    print(f"{len(tokens)} rwa_spot tokens, head block {head:,}", flush=True)

    # Every range covering the chain, shuffled once so the running distinct count is
    # a rarefaction curve rather than a walk through the chain's history.
    passes = [(lo, min(lo + CHUNK - 1, head)) for lo in range(0, head + 1, CHUNK)]
    random.Random(0).shuffle(passes)

    exact: set[str] = set()
    seen_a: set[str] = set()
    seen_b: set[str] = set()
    curve = []
    events = 0
    blocks = 0
    deadline = time.time() + args.minutes * 60
    started = time.time()

    def work(job):
        idx, (lo, hi) = job
        return idx, lo, hi, fetch_chunk(url, tokens, lo, hi, requests.Session())

    # Bounded submission.  ThreadPoolExecutor.map would queue every job at once and hold
    # each completed result until the consumer reached it in order, which is gigabytes
    # of log dicts waiting on one slow chunk.  Keep 2x workers in flight.
    pool = ThreadPoolExecutor(max_workers=args.workers)
    jobs = iter(list(enumerate(passes)))
    inflight = {pool.submit(work, j) for j in islice(jobs, args.workers * 2)}
    done_n = 0
    try:
        while inflight:
            done, inflight = wait(inflight, return_when=FIRST_COMPLETED)
            for fut in done:
                idx, lo, hi, logs = fut.result()
                for log in logs:
                    for topic in (log["topics"][1], log["topics"][2]):
                        addr = topic[26:]
                        exact.add(addr)
                        if topic[62:64] == "00":
                            seen_a.add(addr)
                        if topic[48:50] == "00":
                            seen_b.add(addr)
                events += len(logs)
                blocks += hi - lo + 1
                done_n += 1
                if done_n % 25 == 0:
                    curve.append({"events": events, "blocks": blocks,
                                  "distinct": len(exact)})
                if done_n % 200 == 0:
                    print(f"  {done_n:,} chunks  {events:,} events  {blocks:,} blocks  "
                          f"{events/max(time.time()-started,1e-9):,.0f} ev/s  "
                          f"distinct {len(exact):,}", flush=True)
            if time.time() > deadline:
                break
            for j in islice(jobs, len(done)):
                inflight.add(pool.submit(work, j))
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    curve.append({"events": events, "blocks": blocks, "distinct": len(exact)})

    result = {
        "head_block": head,
        "tokens": len(tokens),
        "chunks": done_n,
        "blocks_sampled": blocks,
        "block_fraction": blocks / head,
        "events_sampled": events,
        "sketch_modulus": MOD,
        "distinct_exact": len(exact),
        "sketch_a": {"kept": len(seen_a), "estimate": len(seen_a) * MOD,
                     "error": len(seen_a) * MOD / max(len(exact), 1) - 1},
        "sketch_b": {"kept": len(seen_b), "estimate": len(seen_b) * MOD,
                     "error": len(seen_b) * MOD / max(len(exact), 1) - 1},
        "rarefaction": curve,
        "elapsed_s": round(time.time() - started, 1),
    }
    OUT.write_text(json.dumps(result, indent=2))
    print(json.dumps({k: v for k, v in result.items() if k != "rarefaction"}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
