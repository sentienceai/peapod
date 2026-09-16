"""decimals() for every token the leaderboard prices, read from the chain.

WHY. The token registry was built for tokenized equities and has decimals for those. It
has none for 60 of the 90 Pons pools. Quantity scales by 10^-k and price by 10^+k, so
their PRODUCT is unaffected and PnL is safe either way -- which is why the Pons probe could
report without them. A leaderboard cannot: it shows a quantity and a price per trade, and
both are wrong by a power of ten when k is a guess.

So they are read from the contract rather than assumed to be 18. A token that does not
answer is recorded as unknown and its rows are excluded from display columns, never
defaulted -- an 18 that is really a 6 is a trillion-fold error that looks plausible.

Usage:  uv run python ingest/token_decimals.py
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import polars as pl
import requests

HERE = Path(__file__).resolve().parent
OUT = HERE / "out" / "token_decimals.parquet"
DECIMALS = "0x313ce567"          # decimals()
SYMBOL = "0x95d89b41"            # symbol()


def decode_string(hexdata: str) -> str | None:
    """ERC-20 symbol() returns string, but plenty of older tokens return bytes32."""
    raw = bytes.fromhex(hexdata[2:]) if hexdata.startswith("0x") else bytes.fromhex(hexdata)
    if len(raw) == 32:
        return raw.rstrip(b"\x00").decode("utf-8", "ignore").strip() or None
    if len(raw) >= 64:
        try:
            offset = int.from_bytes(raw[0:32], "big")
            length = int.from_bytes(raw[offset:offset + 32], "big")
            if 0 < length <= 64:
                text = raw[offset + 32:offset + 32 + length]
                return text.decode("utf-8", "ignore").strip() or None
        except Exception:                       # noqa: BLE001
            return None
    return None


def env() -> dict[str, str]:
    values: dict[str, str] = {}
    for line in (HERE.parent / ".env").read_text().splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, _, v = line.partition("=")
            values[k.strip()] = v.strip().strip("'\"")
    return values


def fetch(url: str, addresses: list[str], selector: str = DECIMALS) -> dict:
    out: dict = {}
    session = requests.Session()
    for i in range(0, len(addresses), 50):
        chunk = addresses[i:i + 50]
        payload = [{"jsonrpc": "2.0", "id": j, "method": "eth_call",
                    "params": [{"to": a, "data": selector}, "latest"]}
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
                    if selector == SYMBOL:
                        out[a] = decode_string(res)
                        continue
                    v = int(res[:66], 16)
                    out[a] = v if 0 <= v <= 36 else None
                break
            except Exception:                       # noqa: BLE001
                if attempt == 4:
                    for a in chunk:
                        out[a] = None
                    break
                time.sleep(2 ** attempt)
    return out


def known(extra: dict[str, int] | None = None) -> dict[str, int]:
    """address -> decimals, from the cache. Unknown tokens are simply absent."""
    table: dict[str, int] = dict(extra or {})
    if OUT.exists():
        df = pl.read_parquet(OUT)
        for a, d in zip(df["address"], df["decimals"]):
            if d is not None:
                table[a] = int(d)
    return table


def symbols(extra: dict[str, str] | None = None) -> dict[str, str]:
    """address -> symbol, from the cache, for tokens the registry never named."""
    table: dict[str, str] = dict(extra or {})
    if OUT.exists():
        df = pl.read_parquet(OUT)
        if "symbol" in df.columns:
            for a, sy in zip(df["address"], df["symbol"]):
                if sy:
                    table[a] = str(sy)
    return table


def main() -> int:
    import sys  # noqa: PLC0415
    sys.path.insert(0, str(HERE.parent / "export"))
    from upstream import lp_terminal  # noqa: PLC0415
    root = lp_terminal()
    # Only the pools the leaderboard prices, not all 384,930 on the chain.
    basket = json.loads(Path("/Users/sentientai/canopy/data/pons-basket.json").read_text())
    ids = {t["pair"] for t in basket["tokens"] if t.get("pair")}
    pools = pl.concat([pl.read_parquet(p)
                       for p in sorted((root / "out" / "raw" / "pools").glob("part-*.parquet"))])
    tok = pl.read_parquet(root / "out" / "raw" / "tokens" / "part-00000.parquet")
    have = {a for a, d in zip(tok["address"], tok["decimals"]) if d is not None}
    # Only the 90 Pons pools. Everything the RWA side prices already has decimals in the
    # registry; filtering 384,930 pools with two large is_in lists takes minutes and finds
    # nothing extra.
    priced = pools.filter(pl.col("pool_id").is_in(list(ids)))
    wanted = set(priced["currency0"].to_list()) | set(priced["currency1"].to_list())
    todo = sorted(a for a in wanted if a not in have or a not in symbols())
    print(f"{len(wanted):,} tokens in pools, {len(have):,} already have decimals, "
          f"{len(todo):,} to read from the chain")
    if not todo:
        return 0
    url = env()["GOLDSKY_EDGE_URL"]
    got = fetch(url, todo, DECIMALS)
    # Symbols too: the registry was built for equities and names none of these, so a Pons
    # token would otherwise render on a card as the first eight characters of its address.
    syms = fetch(url, todo, SYMBOL)
    rows = [{"address": a, "decimals": d, "symbol": syms.get(a)} for a, d in got.items()]
    if OUT.exists():
        rows += pl.read_parquet(OUT).to_dicts()
    df = pl.DataFrame(rows).unique(subset=["address"])
    df.write_parquet(OUT)
    answered = df.filter(pl.col("decimals").is_not_null()).height
    print(f"{answered:,} of {df.height:,} answered; {df.height - answered:,} did not and are "
          "recorded as unknown rather than defaulted to 18")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
