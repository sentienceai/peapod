"""Measure an RPC endpoint's SUSTAINED throughput, which is the number that decides a run.

Latency is not the number. The free public node served a 100-sub-request batch in 0.30s
and then refused 14 of 14 under sustained load; a single fast call told us nothing about
whether a multi-hour job would finish.

PROTOCOL. Fixed batch size at fixed pacing, many rounds, reporting completed sub-requests
per wall-clock second and the success rate. Two controls the first version of this
benchmark lacked:

  order effect   the opening setting is re-run last. If throughput has collapsed by then,
                 the endpoint is degrading cumulatively and the middle results are
                 measuring the damage from earlier trials rather than the setting itself.
                 Without this control a cumulative throttle reads as "batch size 100 is
                 refused", which is a different and wrong conclusion.

  recovery       a pause before each trial, so one bad setting does not poison the next.

Nothing here prints the key: it is read from .env, used in a query string, and redacted
from every message.

Usage:  PEAPOD_RPC_URL=... uv run python ingest/benchmark_rpc.py [--label NAME]
"""

from __future__ import annotations

import argparse
import os
import time
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent


def load_env() -> dict[str, str]:
    values: dict[str, str] = {}
    env = HERE.parent / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, _, v = line.partition("=")
                values[k.strip()] = v.strip().strip("'\"")
    return values


def redactor(secrets: list[str]):
    def clean(text: str) -> str:
        for s in secrets:
            if s:
                text = text.replace(s, "[REDACTED]")
        return text
    return clean


def trial(session, url, make, sub: int, pace: float, rounds: int, clean):
    """One setting. Returns sustained sub-requests/second and the success rate."""
    ok = failures = 0
    codes: dict[str, int] = {}
    began = time.time()
    for r in range(rounds):
        payload = make(r, sub)
        try:
            resp = session.post(url, json=payload, timeout=90)
            label = str(resp.status_code)
            good = resp.status_code == 200
            if good:
                body = resp.json()
                good = isinstance(body, list) and len(body) == sub and all(
                    "result" in x for x in body)
                if not good:
                    label = "200-incomplete"
            if good:
                ok += 1
            else:
                failures += 1
            codes[label] = codes.get(label, 0) + 1
        except requests.RequestException as e:
            failures += 1
            name = type(e).__name__
            codes[name] = codes.get(name, 0) + 1
        time.sleep(pace)
    elapsed = max(time.time() - began, 1e-9)
    completed = ok * sub
    return {"sub": sub, "pace": pace, "ok": ok, "rounds": rounds,
            "rate": completed / elapsed, "codes": codes}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="endpoint")
    ap.add_argument("--rounds", type=int, default=12)
    ap.add_argument("--base-block", type=int, default=40_000_000)
    args = ap.parse_args()

    env = load_env()
    # The endpoint URL is taken as given, never reconstructed from a key: an earlier
    # attempt built the path as evm/4663 when the network id is evm:4663, and the 401 that
    # produced was read as an auth failure when it was partly a routing one.
    url = os.environ.get("PEAPOD_RPC_URL") or env.get("GOLDSKY_EDGE_URL", "")
    if not url:
        raise SystemExit("set PEAPOD_RPC_URL, or GOLDSKY_EDGE_URL in .env")
    clean = redactor([v for v in env.values() if v and len(v) > 12] + [url])
    session = requests.Session()

    print(f"benchmarking {args.label}: {clean(url.split('?')[0])}")
    probe = session.post(url, json={"jsonrpc": "2.0", "id": 1, "method": "eth_chainId",
                                    "params": []}, timeout=30)
    if probe.status_code != 200:
        raise SystemExit(clean(f"chainId probe failed: HTTP {probe.status_code} "
                               f"{probe.text[:200]}"))
    chain = int(probe.json()["result"], 16)
    print(f"  chain id {chain}" + ("" if chain == 4663 else "  <-- NOT Robinhood Chain"))

    # --- what does the advertised per-minute budget actually count? ----------------
    # The budget string says 6krpm. Whether "r" is an HTTP call or a JSON-RPC sub-request
    # changes the full run by 25x, and it cannot be read off the label. One setting
    # separates the two hypotheses: 10 calls a second of 25 sub-requests each is 600 HTTP
    # calls a minute but 15,000 sub-requests a minute. Sustained means the budget counts
    # HTTP calls; refused means it counts sub-requests. A control that is under both
    # ceilings runs first, so a failure cannot be blamed on something else.
    def burst(sub: int, per_second: float, seconds: int):
        ok = refused = other = 0
        deadline = time.time() + seconds
        r = 0
        while time.time() < deadline:
            payload = [{"jsonrpc": "2.0", "id": i, "method": "eth_getBlockByNumber",
                        "params": [hex(args.base_block + r * sub + i), False]}
                       for i in range(sub)]
            try:
                resp = session.post(url, json=payload, timeout=60)
                if resp.status_code == 429:
                    refused += 1
                elif resp.status_code == 200 and isinstance(resp.json(), list):
                    ok += 1
                else:
                    other += 1
            except requests.RequestException:
                other += 1
            r += 1
            time.sleep(max(0.0, 1.0 / per_second))
        return ok, refused, other

    print("\n  budget discriminator (does 6krpm count HTTP calls or sub-requests?)")
    c_ok, c_refused, c_other = burst(25, 8.0 / 25, 45)
    c_http = (c_ok + c_refused + c_other) * 60 / 45
    print(f"    control    25 sub x {8.0/25:.2f}/s -> ~{c_http:,.0f} HTTP/min, "
          f"~{c_http*25:,.0f} sub/min   ok={c_ok} refused={c_refused} other={c_other}")
    time.sleep(20)
    t_ok, t_refused, t_other = burst(25, 10.0, 45)
    t_http = (t_ok + t_refused + t_other) * 60 / 45
    print(f"    test       25 sub x 10/s      -> ~{t_http:,.0f} HTTP/min, "
          f"~{t_http*25:,.0f} sub/min   ok={t_ok} refused={t_refused} other={t_other}")
    if c_refused > c_ok:
        verdict = "INCONCLUSIVE: the control was refused too, so something other than the budget is limiting"
    elif t_refused == 0:
        verdict = "budget counts HTTP CALLS (15,000 sub/min sustained while under 6,000 HTTP/min)"
    elif t_ok == 0:
        verdict = "budget counts SUB-REQUESTS (refused at 15,000 sub/min despite only 600 HTTP/min)"
    else:
        verdict = (f"budget counts SUB-REQUESTS, partially (ok={t_ok} refused={t_refused}); "
                   "throughput settles near the sub-request ceiling")
    print(f"    -> {verdict}")
    time.sleep(20)

    base = args.base_block
    blocks = lambda r, n: [{"jsonrpc": "2.0", "id": i, "method": "eth_getBlockByNumber",
                            "params": [hex(base + r * n + i), True]} for i in range(n)]

    settings = [(25, 3.0), (25, 0.5), (50, 0.5), (100, 0.3), (200, 0.2), (25, 3.0)]
    print(f"\n  {'batch':>6} {'pace':>6} {'ok':>7} {'sustained sub/s':>17}  codes")
    results = []
    for n, pace in settings:
        time.sleep(2.0)                      # recovery, so one setting cannot poison the next
        res = trial(session, url, blocks, n, pace, args.rounds, clean)
        results.append(res)
        print(f"  {n:>6} {pace:>6.2f} {res['ok']:>3}/{res['rounds']:<3} "
              f"{res['rate']:>17,.0f}  {res['codes']}")

    first, last = results[0], results[-1]
    print("\n  order-effect control (same setting, first vs last):")
    print(f"    {first['rate']:,.0f} sub/s  ->  {last['rate']:,.0f} sub/s")
    if first["rate"] > 0 and last["rate"] < first["rate"] * 0.7:
        print("    DEGRADED: the endpoint is throttling cumulatively, so the middle rows")
        print("    measure damage from earlier trials, not the settings themselves.")
    else:
        print("    stable: settings were measured independently.")

    best = max(results[:-1], key=lambda r: r["rate"])
    print(f"\n  best sustained: {best['rate']:,.0f} sub/s at batch {best['sub']} "
          f"every {best['pace']}s ({best['ok']}/{best['rounds']} complete)")
    for label, n in [("blocks with swaps", 1_815_541), ("distinct transactions", 2_357_126)]:
        if best["rate"] > 0:
            print(f"    {label:<22} {n:>10,} -> {n / best['rate'] / 3600:6.2f} h"
                  f"   ${n / 1e6 * 5:5.2f} at $5/M")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
