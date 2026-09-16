"""Credentials, from the process environment first and a .env file second.

Every ingest module used to read .env directly. There is no .env in a container — it is
gitignored, which is the point — and the platform supplies GOLDSKY_EDGE_URL as an
environment variable instead. So a stage that read only the file would have died on a
KeyError the first time it needed a credential, with a message about a missing key rather
than a missing file.

Process environment wins, because that is what a deployment sets and what an operator
overrides for one run. The file is the local convenience.
"""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def env(*, required: tuple[str, ...] = ()) -> dict[str, str]:
    values: dict[str, str] = {}
    path = ROOT / ".env"
    if path.exists():
        for line in path.read_text().splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, _, v = line.partition("=")
                values[k.strip()] = v.strip().strip("'\"")
    values.update({k: v for k, v in os.environ.items() if v})
    missing = [k for k in required if not values.get(k)]
    if missing:
        raise SystemExit(
            f"missing {', '.join(missing)}. Set it as an environment variable "
            f"(this is what a deployment does) or put it in {path}.")
    return values


# Endpoint and pacing, in one place because getting this wrong twice was one bug too many.
#
# swaps_with_tx defaulted to the public node while holding Edge credentials, and so did
# resolve_senders — the second one cost an identity stage 16 hours instead of 1.6. Both
# now ask here.
PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com"

# MEASURED OVER 60-SECOND TRIALS, NOT BURSTS. A burst of a dozen rounds once reported 317
# sub-requests/s on this endpoint where sustained trials gave 88, because the trial was
# shorter than the per-minute budget it was meant to probe. On Edge:
#
#     batch  pace   blocks/hour   failed
#        25   3.0        26,741        0     <- the public node's setting, used on Edge
#       200   2.0       268,872        0     <- the whole budget, nothing wasted
#       200   0.5       455,920   53,800     <- 90% refused
#       400   1.0             0   60,000     <- refused outright
#
# 200 every 2s is 100 sub-requests a second, which is exactly the documented 6,000 a
# minute. Faster is not faster: it is refused.
PACING = {
    "edge":   {"batch": 200, "pace": 2.0},
    "public": {"batch": 25, "pace": 3.0},
}


def endpoint() -> tuple[str, str]:
    """(url, which) — Edge when credentials exist, the public node otherwise."""
    explicit = os.environ.get("PEAPOD_RPC_URL")
    if explicit:
        return explicit, ("edge" if "goldsky" in explicit.lower() else "public")
    edge = env().get("GOLDSKY_EDGE_URL")
    if edge:
        return edge, "edge"
    return PUBLIC_RPC, "public"


def pacing(which: str) -> tuple[int, float]:
    """Batch size and seconds between calls for an endpoint, overridable by env."""
    base = PACING.get(which, PACING["public"])
    return (int(os.environ.get("PEAPOD_RPC_BATCH", base["batch"])),
            float(os.environ.get("PEAPOD_RPC_PACE", base["pace"])))
