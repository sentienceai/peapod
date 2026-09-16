"""Does a transfer-derived balance actually reconcile against balanceOf?

THE QUESTION. Before spending two weeks on a transfer index and a balance engine,
prove the central assumption on a small sample: that replaying every Transfer event
touching an address reproduces its on-chain balance exactly. If it does not -- because
a token rebases, takes a fee on transfer, or mints without an event -- then the engine
cannot be built the obvious way and we need to know which tokens break it and how many.

METHOD. Take 1,000 addresses from the swap universe, stratified so the sample is not
all winners. Pull every Transfer log on the chain where either topic is one of them,
over the full block range. Replay them into per-(address, token) balances. Then ask the
chain, via balanceOf at a historical block, what the balance actually was, and compare
the two integers exactly. No tolerance: a balance is an integer and either it matches
or the model of the token is wrong.

WHY EXACT, AND AT SEVERAL BLOCKS. Checking only at head would hide a token that drifts
and then gets corrected. Each address is checked at four blocks spread over its own
activity, so a token that diverges partway through shows up as a mismatch at the middle
checkpoints even if the ends agree.

WHAT COUNTS AS A BREAK. A single mismatch on a single token at a single block is enough
to disqualify "sum the transfers" for that token. The report groups mismatches by token,
because the failure mode that matters is systematic (this token rebases) rather than
sporadic (one address, one block, one bug).

Usage:  uv run python ingest/balance_spike.py --stage select|fetch|reconcile|report
"""

from __future__ import annotations

import argparse
import json
import random
import time
from collections import defaultdict
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from itertools import islice
from pathlib import Path

import polars as pl
import requests

HERE = Path(__file__).resolve().parent
OUT = HERE / "out" / "balance_spike"
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
ZERO = "0x0000000000000000000000000000000000000000"
# v4 is a singleton: every pool's inventory sits at the PoolManager, so a transfer
# with the PoolManager on one side is the token leg of a swap we already track.
POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
# Edge refuses a range of 30,000 blocks with -32012 whatever the filter; 20,000 is
# served.  The error text names a 30,000 limit, which is not the one being enforced.
WIDTH = 20_000
N = 1_000


def env() -> dict[str, str]:
    values: dict[str, str] = {}
    for line in (HERE.parent / ".env").read_text().splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, _, v = line.partition("=")
            values[k.strip()] = v.strip().strip("'\"")
    return values


def rpc(url, method, params, session=requests):
    r = session.post(url, json={"jsonrpc": "2.0", "id": 1, "method": method,
                               "params": params}, timeout=180)
    r.raise_for_status()
    body = r.json()
    if "error" in body:
        raise RuntimeError(f"{method}: {body['error']}")
    return body["result"]


def select() -> list[str]:
    """Stratified so the sample is not all winners.

    A sample drawn from the ranked leaderboard would be biased towards addresses that
    completed round-trips, and those are the ones whose balances are most likely to be
    simple.  Three quarters of the swap universe never closed a position, and those are
    exactly the addresses whose holdings came from somewhere a swap tape cannot see.
    """
    base = HERE.parent / "web" / "data" / "address"
    rows = []
    for shard in sorted(base.iterdir()):
        for p in shard.iterdir():
            d = json.loads(p.read_text())
            s = d["summary"]
            rows.append((d["address"], d["status"], s["round_trips"],
                         s["realized"], s["total_volume"]))
    rng = random.Random(7)
    ranked = sorted([r for r in rows if r[2] > 0], key=lambda r: -r[3])
    closed = [r for r in rows if r[2] > 0]
    never = [r for r in rows if r[2] == 0]
    by_volume = sorted(rows, key=lambda r: -r[4])
    picked, seen = [], set()
    for group, n in ((ranked[:200], 100), (by_volume[:500], 100),
                     (closed, 300), (never, 500)):
        for a in rng.sample(group, min(n, len(group))):
            if a[0] not in seen:
                seen.add(a[0])
                picked.append(a[0])
    # Top up from the whole universe if overlaps between strata left us short.
    for a in rng.sample(rows, len(rows)):
        if len(picked) >= N:
            break
        if a[0] not in seen:
            seen.add(a[0])
            picked.append(a[0])
    print(f"{len(rows):,} addresses in the universe, "
          f"{len(closed):,} with a closed round-trip, {len(never):,} without")
    print(f"selected {len(picked):,}")
    return picked[:N]


def fetch(url: str, addrs: list[str], workers: int) -> None:
    """Every Transfer log with one of our addresses on either side, whole chain.

    No token-address filter: it is slower than filtering client-side, and it would
    discard the quote-asset transfers that a cost basis needs.
    """
    OUT.mkdir(parents=True, exist_ok=True)
    pads = ["0x" + "0" * 24 + a[2:] for a in addrs]
    head = int(rpc(url, "eth_blockNumber", []), 16)
    ranges = [(lo, min(lo + WIDTH - 1, head)) for lo in range(0, head + 1, WIDTH)]
    print(f"head {head:,}; {len(ranges):,} ranges x 2 sides", flush=True)

    def work(job):
        side, lo, hi = job
        topics = [TRANSFER, pads, None] if side == "out" else [TRANSFER, None, pads]
        s = requests.Session()
        for attempt in range(5):
            try:
                return side, lo, hi, rpc(url, "eth_getLogs", [{
                    "fromBlock": hex(lo), "toBlock": hex(hi), "topics": topics}], s)
            except Exception:
                if attempt == 4:
                    raise
                time.sleep(2 ** attempt)

    # Values are uint256. They do not fit an i64 and polars will not widen one, so they
    # are carried as decimal strings and parsed at replay. An earlier run fetched all
    # 6,400 ranges and then died on DataFrame construction against a single 4.3e43 value.
    schema = ["token", "src", "dst", "value", "block", "log_index", "n_topics"]
    part = 0

    def flush(buf):
        nonlocal part
        if not buf:
            return
        pl.DataFrame(buf, schema=schema, orient="row").write_parquet(
            OUT / f"transfers-{part:04d}.parquet")
        part += 1
        buf.clear()

    jobs = iter([(side, lo, hi) for lo, hi in ranges for side in ("out", "in")])
    pool = ThreadPoolExecutor(max_workers=workers)
    inflight = {pool.submit(work, j) for j in islice(jobs, workers * 2)}
    rows, done_n, started, total = [], 0, time.time(), 0
    try:
        while inflight:
            done, inflight = wait(inflight, return_when=FIRST_COMPLETED)
            for fut in done:
                side, lo, hi, logs = fut.result()
                for lg in logs:
                    if len(lg["topics"]) != 3:
                        rows.append((lg["address"], "", "", "0", int(lg["blockNumber"], 16),
                                     int(lg["logIndex"], 16), len(lg["topics"])))
                        continue
                    rows.append((lg["address"],
                                 "0x" + lg["topics"][1][26:], "0x" + lg["topics"][2][26:],
                                 str(int(lg["data"][:66], 16)) if len(lg["data"]) >= 66 else "0",
                                 int(lg["blockNumber"], 16), int(lg["logIndex"], 16), 3))
                done_n += 1
                if done_n % 500 == 0:
                    total += len(rows)
                    flush(rows)
                    print(f"  {done_n:,}/{len(ranges)*2:,} calls  {total:,} logs  "
                          f"{done_n/(time.time()-started):.1f} calls/s", flush=True)
            for j in islice(jobs, len(done)):
                inflight.add(pool.submit(work, j))
    finally:
        pool.shutdown(wait=False, cancel_futures=True)

    total += len(rows)
    flush(rows)
    df = pl.concat([pl.read_parquet(p) for p in sorted(OUT.glob("transfers-*.parquet"))])
    df = df.unique(subset=["block", "log_index"]).sort(["block", "log_index"])
    df.write_parquet(OUT / "transfers.parquet")
    (OUT / "addrs.json").write_text(json.dumps({"addrs": addrs, "head": head}))
    print(f"{df.height:,} distinct transfer logs written")


def reconcile(url: str, workers: int) -> None:
    """Replay to a balance, then ask the chain what the balance was."""
    meta = json.loads((OUT / "addrs.json").read_text())
    addrs = set(meta["addrs"])
    df = pl.read_parquet(OUT / "transfers.parquet")
    odd = df.filter(pl.col("n_topics") != 3)
    df = df.filter(pl.col("n_topics") == 3)

    # Checkpoints: four blocks spread over each address's own activity, so a token
    # that diverges partway through is caught rather than averaged away.
    events = defaultdict(list)   # (addr, token) -> [(block, delta)]
    for token, src, dst, value, block in zip(
            df["token"], df["src"], df["dst"], df["value"], df["block"]):
        if src == dst:
            continue          # a self-transfer moves nothing; counting both sides is a bug
        v = int(value)        # uint256, carried as a decimal string; Python ints are exact
        if src in addrs:
            events[(src, token)].append((block, -v))
        if dst in addrs:
            events[(dst, token)].append((block, v))

    checks = []
    for (addr, token), evs in events.items():
        evs.sort()
        blocks = sorted({b for b, _ in evs})
        picks = sorted({blocks[0], blocks[len(blocks) // 3], blocks[2 * len(blocks) // 3],
                        blocks[-1]})
        running, i, expect = 0, 0, {}
        for b in picks:
            while i < len(evs) and evs[i][0] <= b:
                running += evs[i][1]
                i += 1
            expect[b] = running
        for b, want in expect.items():
            checks.append({"address": addr, "token": token, "block": b, "expected": want})
    print(f"{len(events):,} (address, token) pairs, {len(checks):,} checkpoints, "
          f"{odd.height:,} non-standard Transfer logs", flush=True)

    def work(batch):
        s = requests.Session()
        payload = [{"jsonrpc": "2.0", "id": i, "method": "eth_call",
                    "params": [{"to": c["token"],
                                "data": "0x70a08231" + "0" * 24 + c["address"][2:]},
                               hex(c["block"])]} for i, c in enumerate(batch)]
        for attempt in range(5):
            try:
                r = s.post(url, json=payload, timeout=180)
                r.raise_for_status()
                by_id = {x["id"]: x for x in r.json()}
                out = []
                for i, c in enumerate(batch):
                    got = by_id.get(i, {})
                    if "error" in got or not got.get("result") or got["result"] == "0x":
                        out.append({**c, "actual": None,
                                    "error": str(got.get("error", "empty"))[:80]})
                    else:
                        out.append({**c, "actual": int(got["result"][:66], 16)})
                return out
            except Exception:
                if attempt == 4:
                    raise
                time.sleep(2 ** attempt)

    batches = [checks[i:i + 50] for i in range(0, len(checks), 50)]
    results, started = [], time.time()
    pool = ThreadPoolExecutor(max_workers=workers)
    jobs = iter(batches)
    inflight = {pool.submit(work, b) for b in islice(jobs, workers * 2)}
    try:
        while inflight:
            done, inflight = wait(inflight, return_when=FIRST_COMPLETED)
            for fut in done:
                results.extend(fut.result())
            if len(results) % 5000 < 50:
                print(f"  {len(results):,}/{len(checks):,} checks  "
                      f"{len(results)/(time.time()-started):.0f}/s", flush=True)
            for j in islice(jobs, len(done)):
                inflight.add(pool.submit(work, j))
    finally:
        pool.shutdown(wait=False, cancel_futures=True)

    pl.DataFrame(results).write_parquet(OUT / "reconcile.parquet")
    (OUT / "odd.json").write_text(odd.write_json())
    print(f"{len(results):,} checkpoints reconciled")


def report() -> None:
    """Reconciliation rate, what breaks it, and where inventory actually comes from."""
    meta = json.loads((OUT / "addrs.json").read_text())
    addrs = set(meta["addrs"])
    rec = pl.read_parquet(OUT / "reconcile.parquet")
    tf = pl.read_parquet(OUT / "transfers.parquet")
    tok = pl.read_parquet(Path.home() / "lp-terminal" / "out" / "raw" / "tokens"
                          / "part-00000.parquet")
    sym = dict(zip(tok["address"], tok["symbol"]))
    kind = dict(zip(tok["address"], tok["kind"]))

    ok = rec.filter(pl.col("actual").is_not_null())
    failed = rec.filter(pl.col("actual").is_null())
    match = ok.filter(pl.col("expected") == pl.col("actual"))
    print("=" * 72)
    print(f"RECONCILIATION  {match.height:,} of {ok.height:,} checkpoints match exactly "
          f"({match.height / max(ok.height, 1):.2%})")
    print(f"  {failed.height:,} checkpoints could not be read from the chain")
    print(f"  {rec['address'].n_unique():,} addresses, {rec['token'].n_unique():,} tokens")

    bad = ok.filter(pl.col("expected") != pl.col("actual"))
    if bad.height:
        print()
        print(f"MISMATCHES BY TOKEN ({bad.height:,} checkpoints)")
        # A token that rebases or takes a fee fails for nearly every address that holds
        # it.  A token that fails for one address at one block is a different problem.
        per = (bad.group_by("token").agg(
                   pl.len().alias("bad"),
                   pl.col("address").n_unique().alias("addrs"))
               .join(ok.group_by("token").agg(pl.len().alias("checked")), on="token")
               .with_columns(share=pl.col("bad") / pl.col("checked"))
               .sort("bad", descending=True))
        for r in per.head(15).iter_rows(named=True):
            label = sym.get(r["token"]) or kind.get(r["token"]) or "unknown token"
            print(f"  {label:<10} {r['bad']:>6,}/{r['checked']:<6,} checkpoints "
                  f"({r['share']:.1%})  {r['addrs']:,} addresses")
        systematic = per.filter((pl.col("share") > 0.5) & (pl.col("addrs") > 3))
        print(f"  {systematic.height} token(s) fail for most holders: "
              f"the transfer sum does not model them")
        sample = bad.head(5)
        print("  sample:")
        for r in sample.iter_rows(named=True):
            d = r["actual"] - r["expected"]
            print(f"    {sym.get(r['token'], r['token'][:10]):<8} {r['address'][:10]} "
                  f"@{r['block']:<10,} expected {r['expected']:<26} "
                  f"actual {r['actual']:<26} delta {d:+}")

    odd = tf.filter(pl.col("n_topics") != 3)
    print()
    print(f"NON-STANDARD TRANSFER LOGS  {odd.height:,} of {tf.height:,} "
          f"({odd.height / max(tf.height, 1):.3%})")
    if odd.height:
        for r in odd.group_by("token").agg(pl.len().alias("n")).sort(
                "n", descending=True).head(5).iter_rows(named=True):
            print(f"  {sym.get(r['token'], r['token']):<44} {r['n']:,}")

    # Where inventory comes from.  This is the input to the cost-basis decision: a
    # policy for mints matters only in proportion to how much inventory arrives as one.
    std = tf.filter(pl.col("n_topics") == 3).filter(pl.col("src") != pl.col("dst"))
    inbound = std.filter(pl.col("dst").is_in(list(addrs)))
    cls = (pl.when(pl.col("src") == ZERO).then(pl.lit("mint"))
           .when(pl.col("src") == POOL_MANAGER).then(pl.lit("swap (tracked)"))
           .when(pl.col("src").is_in(list(addrs))).then(pl.lit("another sampled address"))
           .otherwise(pl.lit("other address")))
    print()
    print("INBOUND TOKEN MOVEMENTS BY ORIGIN")
    g = (inbound.with_columns(origin=cls).group_by("origin")
         .agg(pl.len().alias("events"), pl.col("dst").n_unique().alias("addrs"))
         .sort("events", descending=True))
    total = inbound.height
    for r in g.iter_rows(named=True):
        print(f"  {r['origin']:<26} {r['events']:>9,} events "
              f"({r['events'] / max(total, 1):>6.1%})  {r['addrs']:,} addresses")

    outbound = std.filter(pl.col("src").is_in(list(addrs)))
    ocls = (pl.when(pl.col("dst") == ZERO).then(pl.lit("burn / redemption"))
            .when(pl.col("dst") == POOL_MANAGER).then(pl.lit("swap (tracked)"))
            .otherwise(pl.lit("other address")))
    print()
    print("OUTBOUND TOKEN MOVEMENTS BY DESTINATION")
    g2 = (outbound.with_columns(dest=ocls).group_by("dest")
          .agg(pl.len().alias("events")).sort("events", descending=True))
    for r in g2.iter_rows(named=True):
        print(f"  {r['dest']:<26} {r['events']:>9,} events "
              f"({r['events'] / max(outbound.height, 1):>6.1%})")
    print("=" * 72)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", required=True,
                    choices=["select", "fetch", "reconcile", "report", "all"])
    ap.add_argument("--workers", type=int, default=10)
    args = ap.parse_args()
    url = env()["GOLDSKY_EDGE_URL"]
    OUT.mkdir(parents=True, exist_ok=True)
    if args.stage in ("select", "all"):
        addrs = select()
        (OUT / "selected.json").write_text(json.dumps(addrs))
    if args.stage in ("fetch", "all"):
        addrs = json.loads((OUT / "selected.json").read_text())
        fetch(url, addrs, args.workers)
    if args.stage in ("reconcile", "all"):
        reconcile(url, args.workers)
    if args.stage in ("report", "all"):
        report()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
