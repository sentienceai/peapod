"""Checks that run before a build commits.

A CRASH IS THE EASY CASE. WAL already handles that: the transaction rolls back and the
site keeps serving the previous build. The dangerous case is a cycle that completes and
produces a build that is internally valid and wrong — a tape that lost a day, a resolver
that returned nobody, a price series that went flat. Nothing errors, and the site quietly
starts serving it.

So every gate compares the new build against the one it would replace, and anything that
FAILS rolls the transaction back rather than committing. Warnings are recorded and
committed, because a gate that cannot distinguish "unusual" from "broken" should not be
allowed to take the site down.

THE BANDS ARE WIDE ON PURPOSE. These are tripwires for a pipeline fault, not an anomaly
detector for the chain. A band tight enough to catch a quiet Sunday is a band that will
block a real build at 3am, and a gate that fires on normal days gets disabled.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field


@dataclass
class Result:
    name: str
    ok: bool
    fatal: bool
    detail: str


@dataclass
class Gates:
    results: list[Result] = field(default_factory=list)

    def check(self, name: str, ok: bool, detail: str, fatal: bool = True) -> bool:
        self.results.append(Result(name, bool(ok), fatal, detail))
        return bool(ok)

    @property
    def failed(self) -> list[Result]:
        return [r for r in self.results if not r.ok and r.fatal]

    @property
    def warned(self) -> list[Result]:
        return [r for r in self.results if not r.ok and not r.fatal]

    def report(self) -> str:
        lines = []
        for r in self.results:
            mark = "ok  " if r.ok else ("FAIL" if r.fatal else "warn")
            lines.append(f"  [{mark}] {r.name}: {r.detail}")
        return "\n".join(lines)

    def as_dict(self) -> dict:
        return {"passed": not self.failed,
                "checks": [{"name": r.name, "ok": r.ok, "fatal": r.fatal,
                            "detail": r.detail} for r in self.results]}


def snapshot(store) -> dict:
    """What the store held before this cycle, for the comparisons below.

    Taken before the transaction opens, because inside it the old values are already gone.
    """
    c = store.counts()
    prev = store.get_meta("stats", {}) or {}
    return {"addresses": c["addresses"], "qualifying": c["qualifying"],
            "build": store.get_meta("build"), "to_ts": prev.get("to_ts"),
            "top_realized": prev.get("top_realized"), "scopes": prev.get("scopes", 0)}


def run(gates: Gates, *, before: dict, stats: dict, trades, views: list,
        missing_ranked: int, address_count: int, eth: dict | None,
        gaps: list | None = None) -> Gates:
    first = not before.get("build")

    # 0. A range the ingest could not read. This is the only gate that describes the tape
    #    rather than the build: everything downstream is arithmetic on rows that are not
    #    there, and it all looks perfectly healthy. The ingest used to print a line and
    #    skip; now it records the range and stops, and this refuses to publish over it.
    outstanding = gaps or []
    blocks = sum(g.get("blocks", 0) for g in outstanding)
    gates.check("no unreadable ranges in the tape", not outstanding,
                f"{len(outstanding)} gap(s) covering {blocks:,} blocks"
                + (f", first at {outstanding[0]['from']:,}: {outstanding[0]['why']}"
                   if outstanding else ""))

    # 1. Time only moves forward. A cursor reset or a stale partition read shows up here
    #    before it shows up as a ranking of last week.
    if before.get("to_ts") and stats.get("to_ts"):
        gates.check("window advances",
                    stats["to_ts"] >= before["to_ts"],
                    f"to_ts {before['to_ts']} -> {stats['to_ts']}")

    # 2. The store accumulates addresses and never deletes, so its count cannot fall.
    #    A fall means rows vanished, which no correct cycle does.
    gates.check("address count does not fall",
                address_count >= before["addresses"],
                f"{before['addresses']:,} -> {address_count:,}")

    # 3. Identity. Two rows for one event means a partition was read twice, and every
    #    volume and PnL figure downstream is inflated.
    import polars as pl  # noqa: PLC0415
    dupes = trades.group_by(["tx", "book"]).len().filter(pl.col("len") > 1).height
    gates.check("no duplicated position changes", dupes == 0,
                f"{dupes:,} (tx, book) pairs appear more than once")

    # 4. Qualification rate. A resolver that returned nobody, or a fold that matched
    #    everything, both land here. Wide band: this is a tripwire, not an anomaly detector.
    if not first and before["qualifying"]:
        ratio = stats["qualifying"] / before["qualifying"]
        gates.check("qualifying count is in band", 0.5 <= ratio <= 2.0,
                    f"{before['qualifying']:,} -> {stats['qualifying']:,} "
                    f"({ratio:.2f}x)")

    # 5. Every row the ranking shows must resolve to a detail record. A ranked address
    #    that 404s is the one failure a visitor is guaranteed to hit.
    gates.check("every ranked address has a detail record", missing_ranked == 0,
                f"{missing_ranked:,} ranked addresses with no stored payload")

    # 6. Every declared scope actually produced a ranking, or a tab leads nowhere.
    empty = [v for v in views if v["rows"] == 0]
    gates.check("every declared view has rows", not empty,
                f"{len(empty)} of {len(views)} views are empty: "
                f"{[v['scope'] for v in empty][:4]}")

    # 7. Numbers are numbers. NaN and Infinity are not JSON and would break the page at
    #    parse time, which is a blank screen rather than a wrong figure.
    bad = [k for k, v in stats.items()
           if isinstance(v, float) and (math.isnan(v) or math.isinf(v))]
    gates.check("no NaN or Infinity in the summary", not bad, f"{bad}")

    # 8. The price series is load-bearing: every ETH-quoted trade is denominated through
    #    it, so a flat or absent series silently rewrites half the table.
    if eth is not None:
        gates.check("eth series is present and moving",
                    eth["points"] > 1000 and eth["spread_pct"] > 0.1,
                    f"{eth['points']:,} points, {eth['spread_pct']:.1f}% range, "
                    f"max gap {eth['max_gap_s']:,}s")
        gates.check("eth series has no long hole", eth["max_gap_s"] < 3600,
                    f"longest gap {eth['max_gap_s']:,}s", fatal=False)

    # 9. A hundredfold jump in the top figure is a decimals or units fault, not a trader.
    if not first and before.get("top_realized"):
        jump = abs(stats["top_realized"]) / max(abs(before["top_realized"]), 1e-9)
        gates.check("top result is in band", 0.2 <= jump <= 5.0,
                    f"${before['top_realized']:,.0f} -> ${stats['top_realized']:,.0f} "
                    f"({jump:.2f}x)", fatal=False)
    return gates


def summarise(gates: Gates) -> str:
    n = len(gates.results)
    f, w = len(gates.failed), len(gates.warned)
    return f"{n - f - w}/{n} gates passed, {f} failed, {w} warned"


def json_report(gates: Gates) -> str:
    return json.dumps(gates.as_dict(), indent=1)
