"""totalSupply() for every token the site prices, read from the chain each cycle.

WHY IT IS RE-READ AND NOT CACHED. Decimals are a property of the contract and are read
once; supply is a balance. Robinhood-issued equity tokens are minted when somebody buys
the underlying into the chain and burned when they redeem it out, so the number moves on
its own schedule and a figure cached at first sight would drift silently. A market cap
built on a stale supply is wrong in the one direction nobody checks — it looks fine.

WHAT IT IS AND IS NOT. `totalSupply()` is the supply of that token ON THIS CHAIN. It is
not the company's shares outstanding, and for a tokenized equity it is a small fraction of
them: the market cap the site derives from it is the market cap of the token, which is what
the column says. A token that does not answer is recorded as unknown and shows nothing —
never zero, which would read as "nothing is issued" rather than "we could not read it".

COST, per cycle: one eth_call per token, in batches of 50 over one HTTP request each, at
the endpoint's own pacing. Measured on the deployed universe, that is in the low hundreds
of sub-requests and a couple of seconds — a rounding error against the swap ingest, which
moves hundreds of thousands of logs in the same cycle. The stage prints its own count and
elapsed time so the cost stays visible in the cycle log rather than in someone's head.

Usage:  PYTHONPATH=ingest:export uv run python ingest/token_supply.py
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import polars as pl
import requests

from settings import endpoint, pacing

HERE = Path(__file__).resolve().parent
OUT = HERE / "out" / "token_supply.parquet"
TOTAL_SUPPLY = "0x18160ddd"      # totalSupply()
# One HTTP request carries this many eth_calls. 50 is what token_decimals.py uses against
# the same endpoints and what the pacing table below was measured with.
CHUNK = 50
# A supply is an unsigned 256-bit integer. Anything at or above this is a contract that
# answered with something that is not a supply (a revert string read as a number, a
# max-uint sentinel), and it is recorded as unknown rather than printed as 10^59 tokens.
MAX_PLAUSIBLE = 10 ** 30


def fetch(url: str, addresses: list[str], pace: float = 0.0) -> dict[str, int | None]:
    """address -> raw totalSupply, or None where the contract did not answer."""
    out: dict[str, int | None] = {}
    session = requests.Session()
    for i in range(0, len(addresses), CHUNK):
        chunk = addresses[i:i + CHUNK]
        payload = [{"jsonrpc": "2.0", "id": j, "method": "eth_call",
                    "params": [{"to": a, "data": TOTAL_SUPPLY}, "latest"]}
                   for j, a in enumerate(chunk)]
        for attempt in range(5):
            try:
                r = session.post(url, json=payload, timeout=120)
                r.raise_for_status()
                by_id = {x["id"]: x for x in r.json()}
                for j, a in enumerate(chunk):
                    got = by_id.get(j, {})
                    res = got.get("result")
                    if "error" in got or not res or res == "0x":
                        out[a] = None
                        continue
                    try:
                        v = int(res[:66], 16)
                    except ValueError:
                        out[a] = None
                        continue
                    out[a] = v if 0 < v < MAX_PLAUSIBLE else None
                break
            except Exception:                       # noqa: BLE001
                if attempt == 4:
                    for a in chunk:
                        out[a] = None
                    break
                time.sleep(2 ** attempt)
        if pace:
            time.sleep(pace)
    return out


def wanted() -> list[str]:
    """Every token address the site can price.

    The registry, plus the addresses whose symbol had to be read off the chain — the Pons
    side, which the equity registry never named. Asking for the basket's pairs instead
    covered 106 addresses and left 176 of the 253 tokens the last build shipped with no
    supply at all, which is a market-cap column that is empty for two thirds of the table.
    """
    sys.path.insert(0, str(HERE.parent / "export"))
    from registry import tokens as _tokens  # noqa: PLC0415
    from token_decimals import known as _decimals  # noqa: PLC0415
    addrs = {str(a).lower() for a in _tokens()["address"].to_list()
             if isinstance(a, str) and a.startswith("0x")}
    addrs |= {a.lower() for a in _decimals() if a.startswith("0x")}
    return sorted(addrs)


def known() -> dict[str, dict]:
    """address -> {supply, read_at} from the last read. Unknown tokens are absent."""
    if not OUT.exists():
        return {}
    df = pl.read_parquet(OUT)
    table: dict[str, dict] = {}
    for row in df.iter_rows(named=True):
        if row.get("supply") is None:
            continue
        table[str(row["address"]).lower()] = {
            "supply": float(row["supply"]), "read_at": int(row["read_at"])}
    return table


def decimals_table() -> dict[str, int]:
    """address -> decimals, the registry's own plus the ones read off the chain.

    token_decimals.known() is only the CACHE — the Pons tokens the equity registry never
    named. Reading supply with that alone left 187 tokens answered-but-unscalable, because
    every tokenized equity's decimals live in the registry and were never passed in.
    """
    sys.path.insert(0, str(HERE.parent / "export"))
    from registry import tokens as _tokens  # noqa: PLC0415
    from token_decimals import known as _known  # noqa: PLC0415
    seed = {}
    df = _tokens()
    for a, d in zip(df["address"].to_list(), df["decimals"].to_list()):
        if isinstance(a, str) and d is not None:
            seed[a.lower()] = int(d)
    return _known(seed)


def main() -> int:
    addresses = wanted()
    if not addresses:
        print("token supply: no priced tokens in the registry; nothing to read")
        return 0
    url, which = endpoint()
    _, pace = pacing(which)
    dec = decimals_table()
    t0 = time.time()
    raw = fetch(url, addresses, pace=0.0)
    elapsed = time.time() - t0

    read_at = int(time.time())
    rows = []
    unscaled = 0
    for a in addresses:
        v = raw.get(a)
        d = dec.get(a)
        # No decimals, no supply. Scaling by an assumed 18 when the token uses 6 is a
        # trillion-fold error that looks like a plausible market cap.
        if v is None or d is None:
            if v is not None and d is None:
                unscaled += 1
            rows.append({"address": a, "supply": None, "raw": str(v) if v is not None else None,
                         "decimals": d, "read_at": read_at})
            continue
        rows.append({"address": a, "supply": v / (10 ** d), "raw": str(v),
                     "decimals": d, "read_at": read_at})
    df = pl.DataFrame(rows, schema={"address": pl.Utf8, "supply": pl.Float64, "raw": pl.Utf8,
                                    "decimals": pl.Int64, "read_at": pl.Int64})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    df.write_parquet(OUT)

    answered = df.filter(pl.col("supply").is_not_null()).height
    calls = len(addresses)
    requests_made = (calls + CHUNK - 1) // CHUNK
    print(f"token supply: {calls:,} totalSupply() calls in {requests_made} request(s) "
          f"on the {which} endpoint, {elapsed:.1f}s ({calls / max(elapsed, 0.001):.0f}/s); "
          f"{answered:,} answered, {calls - answered:,} unknown"
          + (f" ({unscaled} answered but have no decimals and cannot be scaled)" if unscaled else ""))
    # A machine-readable line for the cycle log, so the cost is greppable over time.
    print("token supply cost: " + json.dumps(
        {"calls": calls, "requests": requests_made, "seconds": round(elapsed, 2),
         "endpoint": which, "pace": pace, "answered": answered}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
