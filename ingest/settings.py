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
