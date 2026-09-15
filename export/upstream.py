"""Resolving lp-terminal, and refusing to trust it blindly.

peapod's export reads lp-terminal's tapes and calls its Python v4 math. Both are
resolved from PEAPOD_LP_TERMINAL rather than assumed to sit in a sibling directory,
for the same reason tools/parity/generate.sh does it: the moment either repository
moves, a hardcoded path is a silent failure waiting to happen.

The path is the smaller half. The larger half is that peapod ships two implementations
of the same v4 math -- its own BigInt engine in the browser, and lp-terminal's Python
engine in the export -- and a site whose depth numbers and whose calculator disagreed
would be worse than one that had neither. So before the export uses the Python engine,
it runs that engine against the SAME committed fixtures test/fixtures/*.json that pin
the JS engine to canonical v4-core. If lp-terminal ever drifts, the export fails here
with a named mismatch instead of publishing numbers computed by a different engine.

That check is cheap -- 993 cases, well under a second -- and it runs on every export.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from types import ModuleType

HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parent / "test" / "fixtures"


def fail(headline: str, *lines: str) -> None:
    print(f"\nexport failed:\n  {headline}\n", file=sys.stderr)
    for line in lines:
        print(f"  {line}", file=sys.stderr)
    print(file=sys.stderr)
    raise SystemExit(1)


def lp_terminal() -> Path:
    """The lp-terminal checkout, or a clear explanation of why we cannot continue."""
    raw = os.environ.get("PEAPOD_LP_TERMINAL", "")
    if not raw:
        fail(
            "PEAPOD_LP_TERMINAL is not set.",
            "It must point at an lp-terminal checkout, which supplies the swap and",
            "ModifyLiquidity tapes under out/raw/ and the v4 math in engine/:",
            "",
            "  PEAPOD_LP_TERMINAL=~/lp-terminal uv run python export/build.py",
        )
    root = Path(raw).expanduser()
    if not root.is_dir():
        fail("PEAPOD_LP_TERMINAL points at a directory that does not exist:", f"  {root}")
    for probe, what in [
        ("engine/liquidity_math.py", "the v4 math engine"),
        ("out/raw/swaps_phase4", "the swap tape"),
        ("out/raw/modifyliquidity", "the ModifyLiquidity tape"),
        ("out/raw/pools", "the pool registry"),
        ("out/raw/tokens", "the token registry"),
        ("out/block_times.parquet", "the block-time index"),
    ]:
        if not (root / probe).exists():
            fail(
                f"lp-terminal is missing {what}.",
                f"  looked for: {root / probe}",
                "The research pipeline may not have been run in this checkout.",
            )
    return root


def _fixture(name: str) -> dict:
    path = FIXTURES / name
    if not path.exists():
        fail(f"peapod's own fixture {name} is missing.", f"  expected at: {path}",
             "Regenerate with tools/parity/generate.sh.")
    return json.loads(path.read_text())


def verify_engine(lm: ModuleType) -> int:
    """Run lp-terminal's Python engine against peapod's committed v4-core fixtures.

    Returns the number of cases checked. Any mismatch is fatal: publishing depth computed
    by an engine that disagrees with the one in the browser is the failure this prevents.
    """
    checked = 0

    positions = _fixture("positions.json")
    for p in positions["positions"]:
        got0, got1 = lm.modify_liquidity_delta(
            p["tick"], int(p["sqrtPriceX96"]), p["tickLower"], p["tickUpper"],
            int(p["liquidityDelta"]),
        )
        if (got0, got1) != (int(p["expectedAmount0"]), int(p["expectedAmount1"])):
            fail(
                "lp-terminal's Python v4 engine disagrees with peapod's parity fixtures.",
                f"  positions.json / {p['label']}",
                f"  expected ({p['expectedAmount0']}, {p['expectedAmount1']})",
                f"  got      ({got0}, {got1})",
                "",
                "peapod's browser engine is pinned to these fixtures, so exporting now",
                "would publish numbers the calculator cannot reproduce. Reconcile the two",
                "engines before re-running.",
            )
        checked += 1

    for case in _fixture("tick-sweep.json")["cases"]:
        got = lm.get_sqrt_price_at_tick(case["tick"])
        if got != int(case["sqrtPriceX96"]):
            fail("lp-terminal's Python TickMath disagrees with peapod's parity fixtures.",
                 f"  tick {case['tick']}: expected {case['sqrtPriceX96']}, got {got}")
        checked += 1

    for case in _fixture("delta-sweep.json")["cases"]:
        args = (int(case["sqrtA"]), int(case["sqrtB"]), int(case["liquidity"]), case["roundUp"])
        if lm.get_amount0_delta(*args) != int(case["amount0"]) or \
           lm.get_amount1_delta(*args) != int(case["amount1"]):
            fail("lp-terminal's Python SqrtPriceMath disagrees with peapod's fixtures.",
                 f"  sqrtA={case['sqrtA']} sqrtB={case['sqrtB']} L={case['liquidity']} "
                 f"roundUp={case['roundUp']}")
        checked += 1

    for case in _fixture("boundary-sweep.json")["cases"]:
        liq = int(case["liquidity"])
        add = lm.modify_liquidity_delta(case["tick"], int(case["sqrtPriceX96"]),
                                        case["tickLower"], case["tickUpper"], liq)
        rem = lm.modify_liquidity_delta(case["tick"], int(case["sqrtPriceX96"]),
                                        case["tickLower"], case["tickUpper"], -liq)
        if add != (int(case["add0"]), int(case["add1"])) or \
           rem != (int(case["remove0"]), int(case["remove1"])):
            fail("lp-terminal's Python branch split disagrees with peapod's fixtures.",
                 f"  tick={case['tick']} range=[{case['tickLower']},{case['tickUpper']}]")
        checked += 1

    return checked


def engine(root: Path | None = None) -> tuple[ModuleType, Path, int]:
    """(verified liquidity_math module, lp-terminal root, fixture cases checked)."""
    root = root or lp_terminal()
    sys.path.insert(0, str(root / "engine"))
    import liquidity_math  # noqa: PLC0415

    return liquidity_math, root, verify_engine(liquidity_math)
