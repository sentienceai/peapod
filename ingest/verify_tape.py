"""Resample an ingested tape against a second provider and check it is complete.

WHY THIS EXISTS. An ingest that silently skipped a block range looks exactly like one that
found nothing there: a clean run, no errors, a plausible row count. Goldsky Edge returns
`{"error": {"code": -32012}}` inside an HTTP 200 for an over-wide getLogs range, and reading
`.get("result", [])` on that turns "your range was too wide" into "there is nothing here"
while the cursor moves on. That mistake cost three orders of magnitude on a Pons ingest —
440 rows where the truth was hundreds of thousands — and nothing about the run looked wrong.

Row counts agreeing between two ingests does not settle it either, if both read the same
endpoint: they then agree on what they have and are silent about what they both missed.

So completeness is measured, not argued: pick random windows, ask a DIFFERENT provider what
is in them, and compare both the count and the exact (block, log_index) identities. Counts
alone would pass a tape that holds the right number of the wrong rows.

Usage:
  PEAPOD_LP_TERMINAL=~/lp-terminal PYTHONPATH=ingest:export \
    uv run python ingest/verify_tape.py --tape swaps_tx [--windows 20] [--width 5000]
"""

from __future__ import annotations

import argparse
import pathlib
import time

import numpy as np
import polars as pl
import requests

HERE = pathlib.Path(__file__).resolve().parent
PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"




def query(session, url, lo, hi, pool_ids):
    """Logs in a range, or None if the provider refused. Never an empty list on refusal."""
    params = {"fromBlock": hex(lo), "toBlock": hex(hi), "address": PM,
              "topics": [SWAP, pool_ids]}
    r = session.post(url, json={"jsonrpc": "2.0", "id": 1, "method": "eth_getLogs",
                                "params": [params]}, timeout=180)
    if r.status_code != 200:
        return None
    body = r.json()
    # The payload is the answer, not the status code.
    if "result" not in body:
        return None
    return body["result"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tape", default="swaps_tx")
    ap.add_argument("--windows", type=int, default=20)
    ap.add_argument("--width", type=int, default=5_000)
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()

    directory = HERE / "out" / args.tape
    parts = sorted(directory.glob("part-*.parquet"))
    if not parts:
        raise SystemExit(f"no tape at {directory}")
    tape = pl.concat([pl.read_parquet(p) for p in parts])
    pool_ids = sorted(tape["pool_id"].unique().to_list())
    lo, hi = int(tape["block"].min()), int(tape["block"].max())
    print(f"tape {args.tape}: {len(tape):,} rows, {len(pool_ids)} pools, "
          f"blocks {lo:,}..{hi:,}")
    print(f"resampling {args.windows} random windows of {args.width:,} blocks "
          f"from a second provider\n")

    url = env()["GOLDSKY_EDGE_URL"]
    session = requests.Session()
    rng = np.random.default_rng(args.seed)

    checked = matched = 0
    refused = 0
    missing_total = extra_total = 0
    failures = []
    for _ in range(args.windows):
        start = int(rng.integers(lo, max(hi - args.width, lo + 1)))
        end = start + args.width - 1
        logs = query(session, url, start, end, pool_ids)
        if logs is None:
            refused += 1
            time.sleep(2.0)
            continue
        theirs = {(int(l["blockNumber"], 16), int(l["logIndex"], 16)) for l in logs}
        window = tape.filter((pl.col("block") >= start) & (pl.col("block") <= end))
        ours = set(zip(window["block"].to_list(), window["log_index"].to_list()))
        missing = theirs - ours          # on chain, absent from the tape
        extra = ours - theirs            # in the tape, not on chain
        checked += 1
        matched += not (missing or extra)
        missing_total += len(missing)
        extra_total += len(extra)
        flag = "ok" if not (missing or extra) else f"MISSING {len(missing)} EXTRA {len(extra)}"
        print(f"  {start:>11,}..+{args.width:,}  provider={len(theirs):>6,}  "
              f"tape={len(ours):>6,}  {flag}")
        if missing or extra:
            failures.append({"start": start, "missing": sorted(missing)[:5],
                             "extra": sorted(extra)[:5]})
        time.sleep(1.2)

    print(f"\n  windows compared      {checked}")
    print(f"  provider refused      {refused}")
    print(f"  exact matches         {matched}")
    print(f"  logs on chain but not in the tape   {missing_total:,}")
    print(f"  logs in the tape but not on chain   {extra_total:,}")
    if failures:
        print("\n  FAILED. Sample of the first disagreement:")
        f = failures[0]
        print(f"    window {f['start']:,}: missing {f['missing']}  extra {f['extra']}")
        return 1
    if checked == 0:
        print("\n  INCONCLUSIVE: no window could be compared")
        return 2
    print(f"\n  complete: every sampled window matches the provider exactly, "
          f"on identity not just count")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
