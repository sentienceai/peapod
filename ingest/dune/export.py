"""Export the tx.from mapping from Dune, for checking against the RPC-resolved set.

Dune is a second derivation, not a replacement. Nothing here is trusted until
`compare.py` has asserted it equal to peapod's own resolution over their overlap.

Usage:  uv run python ingest/dune/export.py [--limit-rows N]
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import polars as pl
import requests

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "out" / "tx_from_dune"
STATE = HERE.parent / "out" / "tx_from_dune.state.json"
API = "https://api.dune.com/api/v1"
PAGE = 200_000


def env() -> dict[str, str]:
    values: dict[str, str] = {}
    path = HERE.parent.parent / ".env"
    if path.exists():
        for line in path.read_text().splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, _, v = line.partition("=")
                values[k.strip()] = v.strip().strip("'\"")
    return values


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit-rows", type=int, default=None)
    args = ap.parse_args()

    cfg = env()
    key, query = cfg.get("DUNE_API_KEY"), cfg.get("DUNE_QUERY_ID")
    if not key or not query:
        raise SystemExit("set DUNE_API_KEY and DUNE_QUERY_ID in .env (see ingest/dune/README.md)")
    session = requests.Session()
    session.headers["X-Dune-API-Key"] = key
    OUT.mkdir(parents=True, exist_ok=True)

    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    execution = state.get("execution_id")
    if not execution:
        r = session.post(f"{API}/query/{query}/execute", json={"performance": "medium"}, timeout=60)
        r.raise_for_status()
        execution = r.json()["execution_id"]
        state = {"execution_id": execution, "offset": 0, "part": 0, "rows": 0}
        STATE.write_text(json.dumps(state, indent=1))
        print(f"started execution {execution}")

    while True:
        s = session.get(f"{API}/execution/{execution}/status", timeout=60).json()
        st = s.get("state")
        if st == "QUERY_STATE_COMPLETED":
            total = int(s.get("result_metadata", {}).get("total_row_count", 0) or 0)
            print(f"query complete: {total:,} rows")
            break
        if st in ("QUERY_STATE_FAILED", "QUERY_STATE_CANCELLED"):
            raise SystemExit(f"execution {st}: {json.dumps(s)[:400]}")
        print(f"  {st} ...", flush=True)
        time.sleep(15)

    began = time.time()
    while True:
        if args.limit_rows and state["rows"] >= args.limit_rows:
            break
        r = session.get(f"{API}/execution/{execution}/results",
                        params={"limit": PAGE, "offset": state["offset"]}, timeout=180)
        r.raise_for_status()
        rows = r.json().get("result", {}).get("rows", [])
        if not rows:
            break
        # Normalise to the same shape peapod's own resolution writes.
        frame = pl.DataFrame([{"tx_hash": x["tx_hash"], "tx_from": str(x["tx_from"]).lower()}
                              for x in rows])
        frame.write_parquet(OUT / f"part-{state['part']:05d}.parquet")
        state["part"] += 1
        state["rows"] += len(rows)
        state["offset"] += len(rows)
        STATE.write_text(json.dumps(state, indent=1))
        rate = state["rows"] / max(time.time() - began, 1)
        print(f"  {state['rows']:,} rows  ({rate:,.0f}/s)", flush=True)
        if len(rows) < PAGE:
            break

    print(f"\nwrote {state['rows']:,} rows to {OUT}")
    print("now run: uv run python ingest/dune/compare.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
