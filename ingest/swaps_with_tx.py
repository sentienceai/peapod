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
def _endpoint() -> str:
    """Edge when we have it, the public node otherwise.

    The cycle had credentials for Edge and was using the public node anyway, because this
    defaulted to it. Edge takes the whole 7,593-pool filter in one call; the public node
    caps a topic list at 1,000, so the same work costs nine calls there. Both are correct
    now — this is about cost and latency, not correctness.
    """
    explicit = os.environ.get("PEAPOD_RPC_URL")
    if explicit:
        return explicit
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from settings import env as _env  # noqa: PLC0415
        edge = _env().get("GOLDSKY_EDGE_URL")
        if edge:
            return edge
    except Exception:                                   # noqa: BLE001
        pass
    return "https://rpc.mainnet.chain.robinhood.com"


RPC = _endpoint()
POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"
# ~19,081 blocks/hour on this chain, so this is a little over eight days.
COLD_START_BLOCKS = 3_900_000

OUT = Path(__file__).resolve().parent / "out" / "swaps_tx"
CHECKPOINT = Path(__file__).resolve().parent / "out" / "swaps_tx.checkpoint.json"
PIDFILE = Path(__file__).resolve().parent / "out" / "swaps_tx.pid"

LOG_CAP = 10_000          # the endpoint's hard ceiling on one response
TARGET_LOGS = 6_000       # aim below it, so density drift does not cost a retry
# Measured against Edge, not chosen: 30,000 blocks is served and 30,001 is refused, from
# three different base blocks. A run still narrows this further if its endpoint caps lower,
# and remembers what it learned in the checkpoint.
MIN_WIDTH, MAX_WIDTH = 200, 30_000
# Endpoints cap how many values a topic position may hold: the public RPC at 1,000. Start
# below the lowest known cap and halve on refusal.
TOPIC_CHUNK = 900
GAPS = Path(__file__).resolve().parent / "out" / "gaps.json"
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



# What a call came back as. The caller has to tell these apart: shrinking the block range
# fixes one of them, and doing it for the others is how a permanent argument error became
# thousands of silently skipped blocks.
OK, TOO_MANY_LOGS, TOO_MANY_TOPICS, TOO_WIDE, FAILED = (
    "ok", "logs", "topics", "wide", "failed")


def rpc(method: str, params: list, retries: int = 6):
    """One JSON-RPC call, as (outcome, value).

    IT USED TO RETURN None FOR EVERYTHING. A range that returned too many logs and a range
    whose retries had run out were the same value, so the caller shrank the window for both
    and, at the minimum width, skipped. The public RPC rejects a topic list longer than
    1,000 with -32602 "exceed max topics" — a permanent argument error that no amount of
    shrinking fixes — and the ingest read it as a sizing problem and skipped 200 blocks at
    a time for nine hours.
    """
    delay = 1.0
    last = ""
    for _ in range(retries):
        try:
            r = SESSION.post(RPC, json={"jsonrpc": "2.0", "id": 1, "method": method,
                                        "params": params}, timeout=90)
        except requests.RequestException as exc:
            last = f"{type(exc).__name__}"
            time.sleep(delay)
            delay = min(delay * 2, 30)
            continue
        if r.status_code == 429 or r.status_code >= 500:
            last = f"HTTP {r.status_code}"
            time.sleep(delay)
            delay = min(delay * 2, 30)
            continue
        try:
            body = r.json()
        except json.JSONDecodeError:
            last = "non-JSON body"
            time.sleep(delay)
            delay = min(delay * 2, 30)
            continue
        if isinstance(body, dict) and "error" in body:
            message = str(body["error"].get("message", ""))
            low = message.lower()
            # Too many RESULTS: a smaller block range fixes it.
            if "more than" in low or "exceed max results" in low or "too many results" in low \
                    or "query returned more than" in low or "response size" in low:
                return TOO_MANY_LOGS, message
            # Too many FILTER VALUES: a smaller block range never fixes it. Send fewer
            # pool ids per call instead.
            if "max topics" in low or "too many topics" in low or "exceed max topics" in low:
                return TOO_MANY_TOPICS, message
            # Too many BLOCKS. A cap on the span itself, independent of how many logs are
            # in it or how many pools are asked for: Edge serves exactly 30,000 blocks and
            # refuses 30,001, measured from three different base blocks. This is a shrink
            # condition and was landing in FAILED, so a 36,000-block window stopped the
            # run and then retried the identical window every fifteen minutes.
            if "max allowed range" in low or "exceeds maximum of" in low \
                    or "block range" in low:
                return TOO_WIDE, message
            last = message
            time.sleep(delay)
            delay = min(delay * 2, 30)
            continue
        return OK, body.get("result")
    return FAILED, last or "retries exhausted"


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


def fetch(lo: int, hi: int, pool_ids: list[str], chunk: int):
    """Every Swap in [lo, hi] for these pools, over as many calls as the endpoint needs.

    The pool filter is split into chunks because endpoints cap how many values a topic
    position may hold — the public RPC at 1,000, where this was sending 7,593. Chunking is
    the second axis: when the block range cannot shrink any further, this one still can.

    Returns (outcome, logs). A partial result is never returned as a success: if any chunk
    refuses, the whole range refuses, because a union missing one chunk is a hole that
    looks like data.
    """
    out: list[dict] = []
    i = 0
    while i < len(pool_ids):
        sel = pool_ids[i:i + chunk]
        params = {"fromBlock": hex(lo), "toBlock": hex(hi), "address": POOL_MANAGER,
                  "topics": [SWAP_TOPIC, sel]}
        outcome, value = rpc("eth_getLogs", [params])
        if outcome != OK:
            return outcome, value
        out.extend(value or [])
        i += chunk
    return OK, out


def record_gap(lo: int, hi: int, why: str) -> None:
    """A range we could not read, written down where the build gates will find it.

    The ingest used to print a line and move on, so the only record of a hole was a log
    nobody reads and a tape that looked complete. A recorded gap fails the verification
    gate, which means no build is published on top of it.
    """
    GAPS.parent.mkdir(parents=True, exist_ok=True)
    gaps = json.loads(GAPS.read_text()) if GAPS.exists() else []
    gaps.append({"from": lo, "to": hi, "blocks": hi - lo + 1, "why": why,
                 "at": int(time.time())})
    GAPS.write_text(json.dumps(gaps, indent=1))


def stop(state: dict, buffer: list, lo: int, hi: int, why: str) -> None:
    """Flush what is genuinely fetched, record the hole, and leave the cursor where it is.

    The cursor not advancing is the point: the next run retries this range rather than
    building on a tape with a silent hole in it.
    """
    if buffer:
        pl.DataFrame(buffer).write_parquet(OUT / f"part-{state['part']:05d}.parquet")
        state["part"] += 1
        state["rows"] += len(buffer)
        buffer.clear()
    # The cursor is whatever the last SUCCESSFUL range left it at; stop() never moves it.
    save_checkpoint(state)
    record_gap(lo, hi, why)
    print(f"\nSTOPPED at {lo:,}..{hi:,}: {why}", flush=True)
    print(f"  recorded in {GAPS}; the cursor stays at {state.get('cursor') or lo:,} so the next run "
          "retries this range. The verification gate refuses to publish while a gap is "
          "outstanding.", flush=True)


def clear_gaps(lo: int, hi: int) -> None:
    """Subtract a fetched range from the recorded gaps.

    SUBTRACT, NOT MATCH. The gap that prompted this was 36,000 blocks wide, recorded
    before the endpoint's 30,000-block cap was known. No window that satisfies the cap can
    ever CONTAIN it, so a containment test left it recorded for good and the gate blocked
    every future build over a hole that had already been refilled. Each successful window
    now removes its own overlap and leaves whatever is still outstanding.
    """
    if not GAPS.exists():
        return
    gaps = json.loads(GAPS.read_text())
    out, changed = [], False
    for g in gaps:
        a, b = g["from"], g["to"]
        if hi < a or lo > b:                      # no overlap
            out.append(g)
            continue
        changed = True
        if a < lo:                                # remainder before the fetched range
            out.append({**g, "from": a, "to": lo - 1, "blocks": lo - a})
        if b > hi:                                # remainder after it
            out.append({**g, "from": hi + 1, "to": b, "blocks": b - hi})
    if not changed:
        return
    if out:
        GAPS.write_text(json.dumps(out, indent=1))
        left = sum(g["blocks"] for g in out)
        print(f"  gap partly refilled by {lo:,}..{hi:,}; {left:,} blocks still outstanding",
              flush=True)
    else:
        GAPS.unlink()
        print(f"  gap fully refilled by {lo:,}..{hi:,}; none outstanding", flush=True)


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
    ap.add_argument("--verify", type=int, default=0, metavar="N",
                    help="sample N windows across the tape and compare each one's swap "
                         "count against the chain. Reports holes; changes nothing.")
    ap.add_argument("--rewind", action="store_true",
                    help="set the cursor to the last block actually in the tape and clear "
                         "recorded gaps, then exit. For repairing a checkpoint that "
                         "advanced past ranges it never fetched.")
    args = ap.parse_args()
    claim_pidfile(PIDFILE)

    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "export"))
    from registry import pools as registry_pools, tokens as registry_tokens  # noqa: PLC0415

    # WHICH POOLS, AND OVER WHAT RANGE — without another checkout.
    #
    # This read lp-terminal's own swap tape for both: the distinct pool ids in it, and its
    # first and last block. Neither exists in a container, and the cycle died here on every
    # tick. The pools are the RWA universe, which the vendored registry defines; the range
    # is "from where we left off to the head of the chain", which is what an incremental
    # cycle actually wants and what the tape's fixed bounds were only ever standing in for.
    tok = registry_tokens()
    rwa = set(tok.filter(pl.col("kind") == "rwa_spot")["address"].to_list())
    quote = set(tok.filter(pl.col("symbol").is_in(["USDG"]))["address"].to_list())
    meta = registry_pools()
    pool_ids = sorted(meta.filter(
        (pl.col("currency0").is_in(list(rwa)) & pl.col("currency1").is_in(list(quote)))
        | (pl.col("currency1").is_in(list(rwa)) & pl.col("currency0").is_in(list(quote)))
    )["pool_id"].to_list())
    if not pool_ids:
        raise SystemExit("no RWA pools in the registry; run export/registry.py --refresh")

    outcome, value = rpc("eth_blockNumber", [])
    if outcome != OK:
        raise SystemExit(f"cannot read the chain head: {value}")
    head = int(value, 16)
    if args.verify:
        # Answers "does this tape have holes in it" by asking the chain, rather than by
        # reasoning about what the ingest might have done.
        import random  # noqa: PLC0415
        parts = sorted(OUT.glob("part-*.parquet"))
        if not parts:
            print("no tape on disk")
            return 0
        have = pl.concat([pl.read_parquet(p, columns=["block", "log_index", "pool_id"])
                          for p in parts])
        lo, hi = int(have["block"].min()), int(have["block"].max())
# WHAT THIS CAN AND CANNOT TELL APART.
        #
        # A missing swap has two possible causes: a range the ingest skipped, or a pool
        # that was not in the filter when that range was fetched. Comparing against the
        # tape's own pool set removes the second cause only if the universe never changed
        # over the tape's lifetime, and on this tape it did — pools were added as they
        # started trading. So a reported hole means "the chain has swaps here that we do
        # not", which is true and actionable, and does NOT prove which cause. Refetch the
        # range rather than reasoning about it; refetching fixes both.
        mine = sorted(set(have["pool_id"].to_list()))
        print(f"tape covers {lo:,}..{hi:,} with {have.height:,} swaps across "
              f"{len(mine):,} pools; the registry now names {len(pool_ids):,}", flush=True)
        print(f"sampling {args.verify} windows of {MIN_WIDTH} blocks", flush=True)
        rng = random.Random(7)
        holes, checked, grew = [], 0, 0
        for _ in range(args.verify):
            a = rng.randrange(lo, max(lo + 1, hi - MIN_WIDTH))
            b = a + MIN_WIDTH - 1
            outcome, logs = fetch(a, b, mine, TOPIC_CHUNK)
            if outcome != OK:
                print(f"  {a:,}..{b:,}  could not check ({outcome})", flush=True)
                continue
            outcome2, wider = fetch(a, b, pool_ids, TOPIC_CHUNK)
            checked += 1
            ours = have.filter((pl.col("block") >= a) & (pl.col("block") <= b)).height
            theirs = len({(int(x["blockNumber"], 16), int(x["logIndex"], 16)) for x in logs})
            extra = (len({(int(x["blockNumber"], 16), int(x["logIndex"], 16)) for x in wider})
                     - theirs) if outcome2 == OK else 0
            grew += extra
            if ours != theirs:
                holes.append((a, b, ours, theirs))
                print(f"  {a:,}..{b:,}  INCOMPLETE: tape has {ours}, chain has {theirs}",
                      flush=True)
            elif extra:
                print(f"  {a:,}..{b:,}  ok ({ours}); +{extra} in pools added since",
                      flush=True)
        print(f"\n{checked} windows checked")
        if holes:
            missing = sum(t - o for _, _, o, t in holes)
            print(f"  {len(holes)} window(s) INCOMPLETE: {missing:,} swaps the chain has "
                  "and this tape does not, in pools the tape already covers.")
            print("  Cause is not distinguishable after the fact — a skipped range and a "
                  "pool added to the filter later look identical here. Refetch the "
                  "affected span; that fixes both.")
        else:
            print("  complete: every pool the tape covers is whole over the sample")
        if grew:
            print(f"  +{grew:,} swaps in pools added to the universe since this tape was "
                  "built. Not a hole — refetch to pick them up when convenient.")
        return 1 if holes else 0

    if args.rewind:
        parts = sorted(OUT.glob("part-*.parquet"))
        if not parts:
            print("no tape on disk; nothing to rewind to")
            return 0
        last = int(pl.concat([pl.read_parquet(p, columns=["block"]) for p in parts])
                   ["block"].max())
        state = load_checkpoint()
        was = state.get("cursor")
        state["cursor"] = last + 1
        state["complete"] = False
        save_checkpoint(state)
        if GAPS.exists():
            GAPS.unlink()
        print(f"cursor {was:,} -> {last + 1:,} (last block actually in the tape)")
        print(f"rewound by {(was or 0) - last - 1:,} blocks; recorded gaps cleared, since "
              "everything after this point will now be refetched")
        return 0

    state = load_checkpoint()
    # A cold start backfills a window rather than only moving forward: a container with an
    # empty volume that began at the head would take seven days to have a seven-day
    # leaderboard. COLD_START_BLOCKS is about eight days at this chain's rate.
    start = args.start if args.start is not None else max(0, head - COLD_START_BLOCKS)
    end = args.end if args.end is not None else head

    cursor = state["cursor"] if state["cursor"] is not None else start
    OUT.mkdir(parents=True, exist_ok=True)

    print(f"pools {len(pool_ids)}  blocks {start:,}..{end:,}  resuming at {cursor:,}")
    width_cap = int(state.get("max_width") or MAX_WIDTH)
    width = min(20_000, width_cap)
    seen = Deduplicator(key_of=log_key)
    buffer: list[dict] = []
    began = time.time()

    chunk = TOPIC_CHUNK
    while cursor <= end:
        hi = min(cursor + width - 1, end)
        outcome, value = fetch(cursor, hi, pool_ids, chunk)
        state["calls"] += 1

        if outcome == TOO_MANY_TOPICS:
            # Fewer pool ids per call. The block range is irrelevant to this and shrinking
            # it was the bug: at the minimum width the old code gave up and skipped.
            if chunk <= 1:
                stop(state, buffer, cursor, end, "endpoint refuses even one pool id")
                return 1
            chunk = max(1, chunk // 2)
            print(f"  topic filter too large at {cursor:,}; {chunk} pool ids per call",
                  flush=True)
            continue

        if outcome == TOO_WIDE:
            # Learn the endpoint's cap so no width known to fail is ever requested again,
            # then climb back toward it from below rather than probing past it.
            width_cap = min(width_cap, width - 1)
            state["max_width"] = width_cap
            width = max(MIN_WIDTH, min(width // 2, width_cap))
            print(f"  block range too wide at {cursor:,}; capping windows at "
                  f"{width_cap:,} blocks", flush=True)
            continue

        if outcome == TOO_MANY_LOGS:
            if width > MIN_WIDTH:
                width = max(MIN_WIDTH, width // 2)
                time.sleep(PACE * 3)
                continue
            # The block axis is exhausted, so narrow the other one. A single block with
            # more than the cap for ONE pool is the only genuinely unfetchable case.
            if chunk > 1:
                chunk = max(1, chunk // 2)
                print(f"  {MIN_WIDTH}-block window still over the cap at {cursor:,}; "
                      f"{chunk} pool ids per call", flush=True)
                continue
            stop(state, buffer, cursor, hi,
                 f"more than {LOG_CAP:,} logs for one pool in {width} block(s)")
            return 1

        if outcome == FAILED:
            # NEVER SKIP. A range we could not read is a hole, and a hole that advances the
            # cursor is indistinguishable from a range with no swaps in it.
            stop(state, buffer, cursor, hi, f"unreadable: {value}")
            return 1

        logs = value
        clear_gaps(cursor, hi)
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
            width = min(width_cap, int(width * 1.8))
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
