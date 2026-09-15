"""Map each swap transaction to the account that signed it.

A v4 Swap log names the contract that called PoolManager, not the person trading. That
contract is a router almost everywhere on this chain, so identity has to come from the
transaction: `tx.from` is the externally-owned account that paid for and signed the whole
thing, whatever chain of contracts it went through afterwards.

METHOD, AND WHAT IT COST TO FIND IT. Measured against the free public endpoint:

  eth_getBlockReceipts    refused at a batch of 25 — unusable
  eth_getTransactionByHash refused above a batch of ~10
  eth_getBlockByNumber     serves 25 per call, 3s apart, indefinitely

The first version of this script batched 100 getTransactionByHash calls because an earlier
probe had batched 100 getBlockByNumber calls successfully. Those are different methods with
different limits, and generalising from the wrong one produced a script that spent eight
minutes backing off, halving its batch, succeeding once, growing again and being refused —
resolving nothing and using two seconds of CPU while appearing to run.

So this walks BLOCKS, not hashes: one getBlockByNumber(full) returns every transaction in
the block with its `from`, and blocks containing swaps are fewer than the transactions in
them. At the measured safe rate that is 7.9 sub-requests a second, which is 64 hours for
the whole tape — so it runs NEWEST FIRST, leaving a complete recent window at every point
rather than a scatter, and can be stopped and reported on at any depth.

Nothing here infers. A hash that will not resolve is recorded as unresolved and excluded
downstream, never guessed at from the router that appears beside it.

Usage:  uv run python ingest/resolve_senders.py [--since-days N] [--limit N]
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import polars as pl
import requests

RPC = "https://rpc.mainnet.chain.robinhood.com"
HERE = Path(__file__).resolve().parent
SWAPS = HERE / "out" / "swaps_tx"
OUT = HERE / "out" / "tx_from"
CHECKPOINT = HERE / "out" / "tx_from.checkpoint.json"
PIDFILE = Path(__file__).resolve().parent / "out" / "resolve_senders.pid"

# Measured, not assumed: 25 sub-requests 3s apart ran 8/8: anything faster was refused and
# then degraded to refusing everything for a while.
BATCH = 25
PACE = 3.0
PART_ROWS = 50_000

SESSION = requests.Session()


# --- run lock -----------------------------------------------------------------
# Published so a waiter can check `kill -0 PID` instead of pattern-matching command
# lines. A pgrep -f waiter matches its own shell, and its wrapper, and never exits.

def claim_pidfile(path: Path):
    """Write this process's pid, and clear it on exit however the run ends."""
    import atexit
    import os
    import signal

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(str(os.getpid()))

    def release(*_):
        try:
            if path.exists() and path.read_text().strip() == str(os.getpid()):
                path.unlink()
        except OSError:
            pass

    atexit.register(release)
    for sig in (signal.SIGTERM, signal.SIGINT):
        previous = signal.getsignal(sig)
        def handler(signum, frame, _prev=previous):
            release()
            if callable(_prev):
                _prev(signum, frame)
            raise SystemExit(130)
        signal.signal(sig, handler)
    return path



def post(payload, timeout=90):
    return SESSION.post(RPC, json=payload, timeout=timeout)


def resolve_blocks(blocks: list[int], wanted: set[str]) -> tuple[list[dict], list[int]]:
    """(rows for transactions we care about, blocks that did not come back).

    Returns every transaction in each block filtered to `wanted`, the swap transactions.
    Nothing is inferred: a block that will not load is recorded and retried, never guessed.
    """
    payload = [{"jsonrpc": "2.0", "id": i, "method": "eth_getBlockByNumber",
                "params": [hex(b), True]} for i, b in enumerate(blocks)]
    delay = 3.0
    for _ in range(6):
        try:
            r = post(payload, timeout=120)
        except requests.RequestException:
            time.sleep(delay)
            delay = min(delay * 2, 60)
            continue
        if r.status_code == 429 or r.status_code >= 500:
            time.sleep(delay)
            delay = min(delay * 2, 60)
            continue
        try:
            body = r.json()
        except json.JSONDecodeError:
            time.sleep(delay)
            delay = min(delay * 2, 60)
            continue
        if not isinstance(body, list):
            time.sleep(delay)
            delay = min(delay * 2, 60)
            continue
        rows: list[dict] = []
        seen: set[int] = set()
        for entry in body:
            idx = entry.get("id")
            result = entry.get("result")
            if not isinstance(idx, int) or idx >= len(blocks):
                continue
            if not result:
                continue
            seen.add(blocks[idx])
            for tx in result.get("transactions") or []:
                h = tx.get("hash")
                if h in wanted:
                    rows.append({
                        "tx_hash": h,
                        "tx_from": tx["from"].lower(),
                        "tx_to": (tx.get("to") or "").lower() or None,
                        "block": blocks[idx],
                    })
        missing = [b for b in blocks if b not in seen]
        return rows, missing
    return [], list(blocks)


def load_checkpoint() -> dict:
    if CHECKPOINT.exists():
        return json.loads(CHECKPOINT.read_text())
    return {"done": 0, "part": 0, "rows": 0, "unresolved": 0}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-hours", type=float, default=None,
                    help="stop cleanly after this long; the window resolved so far is usable")
    args = ap.parse_args()
    claim_pidfile(PIDFILE)

    parts = sorted(SWAPS.glob("part-*.parquet"))
    if not parts:
        raise SystemExit("no swap parts; run ingest/swaps_with_tx.py first")
    swaps = pl.concat([pl.read_parquet(p) for p in parts])
    wanted = set(swaps["tx_hash"].to_list())

    done_blocks: set[int] = set()
    OUT.mkdir(parents=True, exist_ok=True)
    for existing in sorted(OUT.glob("part-*.parquet")):
        done_blocks.update(pl.read_parquet(existing)["block"].to_list())

    # Newest first: at any moment the resolved set is a complete recent window, which is
    # the only shape that supports an honest answer about what an address has held.
    blocks = sorted(set(swaps["block"].to_list()), reverse=True)
    todo = [b for b in blocks if b not in done_blocks]
    print(f"{len(wanted):,} swap transactions across {len(blocks):,} blocks; "
          f"{len(done_blocks):,} blocks already done, {len(todo):,} to go", flush=True)
    print(f"at {BATCH} per call every {PACE}s that is "
          f"{len(todo) / (BATCH / PACE) / 3600:.1f} hours for the rest", flush=True)

    state = load_checkpoint()
    buffer: list[dict] = []
    unresolved: list[int] = []
    began = time.time()

    for i in range(0, len(todo), BATCH):
        if args.max_hours and (time.time() - began) / 3600 >= args.max_hours:
            print("reached --max-hours; stopping cleanly", flush=True)
            break
        chunk = todo[i:i + BATCH]
        rows, missing = resolve_blocks(chunk, wanted)
        buffer.extend(rows)
        unresolved.extend(missing)

        if len(buffer) >= PART_ROWS:
            pl.DataFrame(buffer).write_parquet(OUT / f"part-{state['part']:05d}.parquet")
            state["part"] += 1
            state["rows"] += len(buffer)
            buffer = []
            CHECKPOINT.write_text(json.dumps(state, indent=1))

        if (i // BATCH) % 40 == 0:
            elapsed = max(time.time() - began, 1)
            rate = (i + len(chunk)) / elapsed
            oldest = min(chunk)
            print(f"  blocks {i + len(chunk):,}/{len(todo):,}  back to {oldest:,}  "
                  f"{rate * 3600 / 1000:.0f}k blocks/h  rows {state['rows'] + len(buffer):,}  "
                  f"unresolved {len(unresolved):,}", flush=True)
        time.sleep(PACE)

    if buffer:
        pl.DataFrame(buffer).write_parquet(OUT / f"part-{state['part']:05d}.parquet")
        state["part"] += 1
        state["rows"] += len(buffer)
    state["unresolved"] = len(unresolved)
    CHECKPOINT.write_text(json.dumps(state, indent=1))
    if unresolved:
        (HERE / "out" / "unresolved_blocks.txt").write_text("\n".join(map(str, unresolved)))
    print(f"\nresolved {state['rows']:,} swap transactions, "
          f"{len(unresolved):,} blocks unresolved, {(time.time() - began) / 60:.1f} min",
          flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
