"""Re-ingest v4 Swap logs, keeping the transaction hash this time.

WHY THIS EXISTS. lp-terminal's swap tape carries `sender` — the address that called
PoolManager — and not the transaction hash. On this chain `sender` is a router contract
almost everywhere: 1,657 distinct senders account for 2.4M swaps, the busiest one alone
doing 430,227 across 83 tickers, and six of the 200 busiest have mined vanity addresses
that no externally-owned account has. Ranking traders by `sender` ranks routers.

The fix is cheap because nothing is missing from the chain — only from the file.
`ingest_lp_events.py` says so in its own header: it "keeps tx_hash and salt, which the
chain-wide ModifyLiquidity pass discarded". The Swap ingest made the same omission, so
this re-runs it with the field kept. `resolve_senders.py` then maps hash to `tx.from`.

The log schema also carries `blockTimestamp`, and it is a trap: this endpoint returns it
as 0x0 for every block, historical and recent alike. The column is kept so the omission is
visible in the data rather than silently absent, but nothing may read it — timestamps still
come from lp-terminal's block_times index.

Usage:  uv run python ingest/swaps_with_tx.py [--from BLOCK] [--to BLOCK]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import polars as pl
import requests

from dedup import Deduplicator, log_key

# The endpoint and its pacing are configuration, not constants, so moving to a paid
# provider is an environment change rather than a code change. The defaults are the free
# public node and the rate it was measured to tolerate: 25 sub-requests per call, 3s
# apart, which ran 8/8 where anything faster was refused and then degraded to refusing
# everything. A provider with 1:1 request billing has no such ceiling, so PEAPOD_RPC_BATCH
# and PEAPOD_RPC_PACE should be raised with it.
RPC = os.environ.get("PEAPOD_RPC_URL", "https://rpc.mainnet.chain.robinhood.com")
POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"

OUT = Path(__file__).resolve().parent / "out" / "swaps_tx"
CHECKPOINT = Path(__file__).resolve().parent / "out" / "swaps_tx.checkpoint.json"
PIDFILE = Path(__file__).resolve().parent / "out" / "swaps_tx.pid"

LOG_CAP = 10_000          # the endpoint's hard ceiling on one response
TARGET_LOGS = 6_000       # aim below it, so density drift does not cost a retry
MIN_WIDTH, MAX_WIDTH = 200, 400_000
PACE = 0.35               # seconds between calls; the endpoint 429s on tight bursts
PART_ROWS = 100_000

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



def rpc(method: str, params: list, retries: int = 6):
    """One JSON-RPC call. Backs off on 429 and 5xx rather than treating them as fatal."""
    delay = 1.0
    for _ in range(retries):
        try:
            r = SESSION.post(RPC, json={"jsonrpc": "2.0", "id": 1, "method": method,
                                        "params": params}, timeout=90)
        except requests.RequestException:
            time.sleep(delay)
            delay = min(delay * 2, 30)
            continue
        if r.status_code == 429 or r.status_code >= 500:
            time.sleep(delay)
            delay = min(delay * 2, 30)
            continue
        try:
            body = r.json()
        except json.JSONDecodeError:
            time.sleep(delay)
            delay = min(delay * 2, 30)
            continue
        if isinstance(body, dict) and "error" in body:
            message = str(body["error"].get("message", ""))
            # A range that returns too many logs is a sizing problem, not a failure.
            if "more than" in message or "limit" in message.lower() or "429" in message:
                return None
            time.sleep(delay)
            delay = min(delay * 2, 30)
            continue
        return body.get("result")
    return None


def signed(value: int) -> int:
    """Reinterpret a 256-bit ABI word as two's complement.

    Narrow signed types are sign-extended to the full word, so an int128 of -1 arrives as
    2**256 - 1, not 2**128 - 1. Interpreting at the declared width instead of the word
    width leaves every negative amount as an enormous positive number.
    """
    return value - (1 << 256) if value >= (1 << 255) else value


def word(data: str, i: int) -> int:
    raw = data[2:] if data.startswith("0x") else data
    return int(raw[i * 64:(i + 1) * 64], 16)


def decode(log: dict) -> dict:
    """One Swap log.

    event Swap(PoolId indexed id, address indexed sender, int128 amount0, int128 amount1,
               uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)
    """
    data = log["data"]
    return {
        "pool_id": log["topics"][1],
        "block": int(log["blockNumber"], 16),
        "block_hash": log.get("blockHash"),
        "removed": bool(log.get("removed", False)),
        "log_index": int(log["logIndex"], 16),
        "tx_hash": log["transactionHash"],
        "tx_index": int(log["transactionIndex"], 16),
        # Always 0x0 on this endpoint. Kept to record that, never read.
        "ts_unreliable": int(log.get("blockTimestamp", "0x0"), 16),
        "sender": "0x" + log["topics"][2][-40:],
        "amount0": str(signed(word(data, 0))),
        "amount1": str(signed(word(data, 1))),
        "sqrt_price_x96": str(word(data, 2)),
        "liquidity": str(word(data, 3)),
        "tick": signed(word(data, 4)),
        "fee": word(data, 5),
    }


def fetch(lo: int, hi: int, pool_ids: list[str]):
    params = {"fromBlock": hex(lo), "toBlock": hex(hi), "address": POOL_MANAGER,
              "topics": [SWAP_TOPIC, pool_ids]}
    return rpc("eth_getLogs", [params])


def load_checkpoint() -> dict:
    if CHECKPOINT.exists():
        return json.loads(CHECKPOINT.read_text())
    return {"cursor": None, "part": 0, "rows": 0, "calls": 0}


def save_checkpoint(state: dict) -> None:
    CHECKPOINT.parent.mkdir(parents=True, exist_ok=True)
    CHECKPOINT.write_text(json.dumps(state, indent=1))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", type=int, default=None)
    ap.add_argument("--to", dest="end", type=int, default=None)
    ap.add_argument("--pools-from", default=None,
                    help="parquet glob whose pool_id column fixes the universe")
    args = ap.parse_args()
    claim_pidfile(PIDFILE)

    lp = Path(__file__).resolve().parent.parent / "export"
    sys.path.insert(0, str(lp))
    from upstream import lp_terminal  # noqa: PLC0415

    root = lp_terminal()
    existing = pl.concat([pl.read_parquet(p) for p in
                          sorted((root / "out" / "raw" / "swaps_phase4").glob("part-*.parquet"))])
    pool_ids = sorted(existing["pool_id"].unique().to_list())
    start = args.start if args.start is not None else int(existing["block"].min())
    end = args.end if args.end is not None else int(existing["block"].max())

    state = load_checkpoint()
    cursor = state["cursor"] if state["cursor"] is not None else start
    OUT.mkdir(parents=True, exist_ok=True)

    print(f"pools {len(pool_ids)}  blocks {start:,}..{end:,}  resuming at {cursor:,}")
    width = 20_000
    seen = Deduplicator(key_of=log_key)
    buffer: list[dict] = []
    began = time.time()

    while cursor <= end:
        hi = min(cursor + width - 1, end)
        logs = fetch(cursor, hi, pool_ids)
        state["calls"] += 1
        if logs is None:
            # Too many logs for this range, or a refusal we should treat as one.
            if width <= MIN_WIDTH:
                print(f"  cannot shrink below {MIN_WIDTH} at {cursor:,}; skipping ahead")
                cursor = hi + 1
                continue
            width = max(MIN_WIDTH, width // 2)
            time.sleep(PACE * 3)
            continue

        for log in logs:
            record = decode(log)
            if seen.accept(record):
                buffer.append(record)
        got = len(logs)
        cursor = hi + 1

        # Steer toward TARGET_LOGS so density drift costs neither retries nor tiny calls.
        if got >= LOG_CAP * 0.95:
            width = max(MIN_WIDTH, width // 2)
        elif got < TARGET_LOGS // 3:
            width = min(MAX_WIDTH, int(width * 1.8))
        elif got > TARGET_LOGS:
            width = max(MIN_WIDTH, int(width * 0.7))

        if len(buffer) >= PART_ROWS:
            part = OUT / f"part-{state['part']:05d}.parquet"
            pl.DataFrame(buffer).write_parquet(part)
            state["part"] += 1
            state["rows"] += len(buffer)
            buffer = []
            state["cursor"] = cursor
            save_checkpoint(state)
            done = (cursor - start) / max(end - start, 1) * 100
            rate = state["rows"] / max(time.time() - began, 1)
            print(f"  {done:5.1f}%  block {cursor:,}  rows {state['rows']:,}  "
                  f"calls {state['calls']:,}  {rate:,.0f} logs/s  width {width:,}")
        time.sleep(PACE)

    if buffer:
        pl.DataFrame(buffer).write_parquet(OUT / f"part-{state['part']:05d}.parquet")
        state["part"] += 1
        state["rows"] += len(buffer)
    state["cursor"] = cursor
    state["complete"] = True
    save_checkpoint(state)
    print(f"\ndone: {state['rows']:,} swaps in {state['part']} parts, "
          f"{state['calls']:,} calls, {(time.time() - began) / 60:.1f} min")
    print(f"identity: {seen.summary()}")
    if seen.conflicts:
        (OUT.parent / "swap_conflicts.json").write_text(json.dumps(seen.conflicts[:1000], indent=1))
        print(f"  {len(seen.conflicts)} position conflicts written to out/swap_conflicts.json -- "
              "same block number and log index on different block hashes, NOT resolved here")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
