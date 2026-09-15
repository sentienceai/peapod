"""Build the four JSON files the site reads.

    web/data/meta.json      provenance: what was measured, when, over what, with what caveats
    web/data/pools.json     the pool universe and what each pool can express
    web/data/depth.json     +/-1% depth per pool, on both bases, with a 7-day series
    web/data/windows.json   the calculator precompute

Every file carries the same provenance block. That is deliberate duplication: these files
get downloaded, linked and quoted individually, and a depth figure that travels without its
anchor and its caveats is a figure that will be misread.

Nothing here reaches the network. It reads lp-terminal's parquet tapes and writes JSON.

Usage:  PEAPOD_LP_TERMINAL=~/lp-terminal uv run python export/build.py
"""

from __future__ import annotations

import datetime as dt
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import polars as pl

import depth as depth_mod
import windows as windows_mod
from tapes import (MIN_DAYS, MIN_SANE_FRACTION, MIN_SWAPS, PRICE_MAX, PRICE_MIN,
                   expressible_widths, in_universe, iso, load)
from upstream import engine, lp_terminal

OUT_DIR = Path(__file__).resolve().parent.parent / "web" / "data"

SUBSIDY_END = "2026-09-29"

HOW_TO_USE = {
    "net_vs_hodl_pct": "il_vs_hodl_pct + 100 * fees(N) / N",
    "fees": "sum over buckets of G * L / (L + A), with L = liquidity_per_dollar * N, "
            "G = fee_kernel_totals[i], A = fee_kernel_active[i]",
    "il_is_size_independent": "the IL term is a percentage of capital and does not move "
                              "with position size; only the fee term does",
    "ranges_snap": "a requested range is snapped to the nearest width present here and the "
                   "UI must say so. Interpolating between widths would be inventing a number.",
    "kernel_error": "each window ships kernel_max_rel_error, the measured worst relative "
                    "error of its bucketing across the certified size range",
}


def git_commit(root: Path) -> str | None:
    try:
        return subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"],
                              capture_output=True, text=True, timeout=10).stdout.strip() or None
    except Exception:
        return None


def provenance(root: Path, anchors, engine_cases: int, pools_valued: int, excluded: dict) -> dict:
    """The block every file carries. Read it as the footnote that cannot be lost."""
    return {
        "generated_at": iso(int(dt.datetime.now(dt.timezone.utc).timestamp())),
        "chain": {"name": "Robinhood Chain", "chain_id": 4663},
        "anchors": anchors.to_json(),
        "source": {
            "repo": "lp-terminal",
            "commit": git_commit(root),
            "tapes": ["out/raw/swaps_phase4", "out/raw/modifyliquidity", "out/raw/pools",
                      "out/raw/tokens", "out/block_times.parquet"],
        },
        "engine": {
            "browser": "web/engine/liquidity-math.js (BigInt port of Uniswap v4-core)",
            "export": "lp-terminal engine/liquidity_math.py",
            "verified_against": "test/fixtures/*.json, the same v4-core ground truth that "
                                "pins the browser engine",
            "cases_checked_this_run": engine_cases,
        },
        "fee_model": {
            "name": "fee_attribution.py",
            "what": "per-swap tick splitting: a swap crossing initialized ticks is split at "
                    "each crossing, each segment carries its own active liquidity, and a "
                    "position earns only on segments its range overlaps",
            "gross_up": "v4 takes the fee from the input before the remainder moves the "
                        "price, so amounts reconstructed from the price path are net of "
                        "fees and are grossed up before the fee is taken",
            "price_taker": "the simulated position is added alongside existing liquidity "
                           "and earns pro rata; the historical swap sequence is replayed "
                           "unchanged, so results describe a marginal position, not one "
                           "that would have displaced the incumbent",
        },
        "universe": {
            "pools_valued": pools_valued,
            "excluded": excluded,
            "filters": {
                "min_swaps": MIN_SWAPS,
                "min_days": MIN_DAYS,
                "price_usd_between": [PRICE_MIN, PRICE_MAX],
                "min_sane_price_fraction": MIN_SANE_FRACTION,
            },
            "note": "identical to lp-terminal's depth_distribution.py, so its published "
                    "figures reproduce and the comparison is not confounded by a different set",
        },
        "depth_bases": {
            "executable": {
                "what": "the +/-1% band split at every initialized tick the price would "
                        "cross, each segment valued with the liquidity actually active "
                        "there; positions whose ranges end inside the band stop "
                        "contributing where they end",
                "verified": "active liquidity at the current tick is the sum of "
                            "liquidityNet at or below it, and every Swap event carries the "
                            "pool's real active liquidity, so the reconstruction is checked "
                            "against the chain at every sample; samples that fail are "
                            "dropped and counted, never valued",
                "headline": "this is the number the site leads with",
            },
            "flat": {
                "what": "lp-terminal's original basis: the whole band valued at the single "
                        "active liquidity under the current tick",
                "caveat": "IT IS NOT AN UPPER BOUND. lp-terminal describes it as one, and "
                          "for most pools it does overstate depth, but liquidity can switch "
                          "ON inside the band as readily as off, and then real depth is "
                          "larger. Across pools with a real book the executable/flat ratio "
                          "runs roughly p5=69%, p50=100%, p95=116%. Treat it as a point "
                          "estimate that errs in BOTH directions, not a ceiling.",
                "why_kept": "it is what lp-terminal published; showing both is the only way "
                            "a reader can see what changed and by how much",
            },
        },
        "caveats": [
            f"Robinhood Chain ran under a gas subsidy that ends {SUBSIDY_END}. Every volume "
            "and activity figure here predates the real cost regime, so every result is "
            "provisional. The study re-runs in October.",
            "Executable depth is dated to the ModifyLiquidity anchor, which is earlier than "
            "the swap tape's end. Volume figures run to the swap tape's end. Both timestamps "
            "are in `anchors`.",
            "The flat-L basis is a point estimate that errs in both directions, not an upper "
            "bound. See depth_bases.flat.caveat.",
            "Chain-wide shares are shares of this universe, not of every pool on the chain.",
        ],
    }


def write(name: str, payload: dict) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / name
    path.write_text(json.dumps(payload, separators=(",", ":"), allow_nan=False, default=_clean))
    return path


def _clean(value):
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return float(value)
    raise TypeError(f"not JSON serialisable: {type(value)}")


def _finite(payload):
    """Replace non-finite floats with null. NaN is not JSON, and a silent NaN is worse."""
    if isinstance(payload, dict):
        return {k: _finite(v) for k, v in payload.items()}
    if isinstance(payload, list):
        return [_finite(v) for v in payload]
    if isinstance(payload, float) and not np.isfinite(payload):
        return None
    return payload



# The windows are split across files on purpose. Held in one object-per-window file they
# came to 12.3 MB, and 39% of that was fee kernels that only ever matter one pool at a
# time -- the calculator never needs another pool's buckets. So windows.json keeps every
# window in COLUMNAR form (one array per field, no repeated key names) so cross-pool views
# work from a single fetch, and each pool's kernels live in windows/<pool_id>.json, fetched
# when that pool is selected.

WINDOW_COLUMNS = [
    "pool_id", "width", "days", "start_ts", "end_ts", "tick_lower", "tick_upper",
    "price_start", "price_end", "liquidity_per_dollar", "il_vs_hodl_pct",
    "position_end_per_dollar", "hodl_end_per_dollar", "time_in_range_pct",
    "fees_total_usd", "kernel_max_rel_error", "swaps",
]


def _sig(value, digits=6):
    if isinstance(value, float) and np.isfinite(value) and value != 0.0:
        return float(f"%.{digits}g" % value)
    return value


def windows_index(rows: list[dict], prov: dict) -> dict:
    """Every window, columnar, without kernels."""
    pools = sorted({r["pool_id"] for r in rows})
    pool_index = {pid: i for i, pid in enumerate(pools)}
    widths = ["full"] + list(windows_mod.WIDTHS)
    width_index = {w: i for i, w in enumerate(widths)}
    columns = {name: [] for name in WINDOW_COLUMNS}
    for r in rows:
        for name in WINDOW_COLUMNS:
            value = r[name]
            if name == "pool_id":
                value = pool_index[value]
            elif name == "width":
                value = width_index[value]
            columns[name].append(_sig(value))
    return {
        "provenance": prov,
        "encoding": {
            "layout": "columnar: each field is one array, all arrays the same length",
            "pool_id": "index into `pools`",
            "width": "index into `widths`",
            "kernels": "not here -- fetch windows/<pool_id>.json for the pool in hand",
        },
        "how_to_use": HOW_TO_USE,
        "size_grid_certified_over": [windows_mod.SIZE_GRID[0], windows_mod.SIZE_GRID[-1]],
        "holding_days": list(windows_mod.HOLDING_DAYS),
        "widths": widths,
        "width_half_pct": [None] + [windows_mod.WIDTHS[w] for w in widths[1:]],
        "pools": pools,
        "count": len(rows),
        "columns": columns,
    }


def write_kernels(rows: list[dict], prov: dict) -> list[Path]:
    """Per-pool fee kernels, keyed by the window's position in windows.json's columns."""
    by_pool: dict[str, list[tuple[int, dict]]] = {}
    for i, r in enumerate(rows):
        by_pool.setdefault(r["pool_id"], []).append((i, r))
    out = []
    directory = OUT_DIR / "windows"
    directory.mkdir(parents=True, exist_ok=True)
    slim = {"generated_at": prov["generated_at"], "anchors": prov["anchors"],
            "fee_model": prov["fee_model"]["name"],
            "caveats": prov["caveats"]}
    for pid, entries in by_pool.items():
        payload = {
            "provenance": slim,
            "pool_id": pid,
            "how_to_use": HOW_TO_USE,
            "window_index": [i for i, _ in entries],
            "fee_kernel_totals": [[_sig(x) for x in r["fee_kernel_totals"]] for _, r in entries],
            "fee_kernel_active": [[_sig(x) for x in r["fee_kernel_active"]] for _, r in entries],
            "liquidity_per_dollar": [_sig(r["liquidity_per_dollar"]) for _, r in entries],
            "kernel_max_rel_error": [_sig(r["kernel_max_rel_error"]) for _, r in entries],
        }
        path = directory / f"{pid}.json"
        path.write_text(json.dumps(_finite(payload), separators=(",", ":"),
                                   allow_nan=False, default=_clean))
        out.append(path)
    return out


def main() -> int:
    root = lp_terminal()
    lm, _, engine_cases = engine(root)
    sys.path.insert(0, str(root / "engine"))
    import fee_attribution as fee_attr  # noqa: PLC0415

    print(f"engine verified against {engine_cases} peapod fixture cases")
    swaps, mods, anchors = load(root)
    print(f"anchors: executable depth at {anchors.to_json()['executable_depth_anchor']['iso']}, "
          f"swap tape ends {anchors.to_json()['swap_tape_end']['iso']} "
          f"({anchors.staleness_hours:.1f}h later)")

    mods_by_pool = {pid: g for (pid,), g in mods.group_by(["pool_id"], maintain_order=True)}
    empty_mods = mods.head(0)

    excluded: dict[str, int] = {}
    pool_rows: list[dict] = []
    depth_rows: list[dict] = []
    window_rows: list[dict] = []
    replay_mismatch_swaps = 0

    groups = list(swaps.group_by(["pool_id"], maintain_order=True))
    for n, ((pid,), group) in enumerate(groups, 1):
        keep, reason = in_universe(group)
        if not keep:
            excluded[reason] = excluded.get(reason, 0) + 1
            continue

        pool_mods = mods_by_pool.get(pid, empty_mods)
        row = depth_mod.per_pool(lm, group, pool_mods, anchors)
        if row is None:
            excluded["tick_map_unverifiable"] = excluded.get("tick_map_unverifiable", 0) + 1
            continue

        spacing = int(group["tick_spacing"][0])
        widths = expressible_widths(spacing, windows_mod.WIDTHS)
        pool_rows.append({
            "pool_id": pid,
            "ticker": group["ticker"][0],
            "quote": group["quote"][0],
            "fee_pips": int(group["pool_fee"][0]) if group["pool_fee"][0] is not None else None,
            "tick_spacing": spacing,
            "rwa_is_token0": bool(group["rwa_is_0"][0]),
            "decimals": [int(group["d0"][0] or 18), int(group["d1"][0] or 18)],
            "swaps": len(group),
            "first_ts": int(group["ts"].min()),
            "last_ts": int(group["ts"].max()),
            "expressible_widths": ["full"] + widths,
            "unexpressible_widths": [w for w in windows_mod.WIDTHS if w not in widths],
        })
        depth_rows.append(row)

        segments = windows_mod.segments_for_pool(
            lm, fee_attr, group, pool_mods, anchors.modify_head_block)
        replay_mismatch_swaps += segments[5]
        for w in windows_mod.build_windows(lm, group, segments[:5], spacing, anchors.modify_head_ts):
            w["pool_id"] = pid
            window_rows.append(w)

        if n % 40 == 0 or n == len(groups):
            print(f"  {n}/{len(groups)} pools scanned, {len(depth_rows)} valued, "
                  f"{len(window_rows):,} windows")

    depth_rows = depth_mod.add_shares(depth_rows)
    prov = provenance(root, anchors, engine_cases, len(depth_rows), excluded)

    total_exec = sum(r["depth_executable"] for r in depth_rows)
    total_flat = sum(r["depth_flat"] for r in depth_rows)
    total_tape = sum(r["depth_flat_at_tape_end"] for r in depth_rows)

    paths = [
        write("meta.json", _finite({
            "provenance": prov,
            "files": {
                "pools.json": "the pool universe and what each pool can express",
                "depth.json": "+/-1% depth per pool, both bases, with a 7-day series",
                "windows.json": "calculator precompute: IL per window and a fee kernel",
            },
            "headline": {
                "top1_share_executable_pct": depth_rows[0]["share_of_chain_executable_pct"],
                "top1_share_flat_pct": max(r["share_of_chain_flat_pct"] for r in depth_rows),
                "top1_share_flat_at_tape_end_pct": (
                    max(r["depth_flat_at_tape_end"] for r in depth_rows) / total_tape * 100
                    if total_tape else None),
                "chain_wide_executable_usd": total_exec,
                "chain_wide_flat_usd": total_flat,
                "pools_below_7d_median_in_top10": sum(
                    1 for r in depth_rows[:10]
                    if r["pct_of_median_executable"] is not None
                    and r["pct_of_median_executable"] < 100),
            },
        })),
        write("pools.json", _finite({"provenance": prov, "pools": pool_rows})),
        write("depth.json", _finite({
            "provenance": prov,
            "totals": {"executable_usd": total_exec, "flat_usd": total_flat,
                       "flat_at_tape_end_usd": total_tape},
            "pools": depth_rows,
        })),
        write("windows.json", _finite(windows_index(window_rows, prov))),
    ]
    paths += write_kernels(window_rows, prov)

    print(f"\nreplay mismatches across all swaps: {replay_mismatch_swaps}")
    print(f"excluded: {excluded}")
    worst_kernel = max((w["kernel_max_rel_error"] for w in window_rows), default=0.0)
    print(f"windows: {len(window_rows):,}  worst certified kernel error: {worst_kernel:.2e}")
    print()
    for path in paths:
        print(f"  {path.relative_to(path.parent.parent.parent)}  "
              f"{path.stat().st_size / 1024:,.0f} KB")
    print(f"\ntop-1 share  executable {depth_rows[0]['share_of_chain_executable_pct']:.1f}%  "
          f"flat {max(r['share_of_chain_flat_pct'] for r in depth_rows):.1f}%  "
          f"flat@tape-end "
          f"{max(r['depth_flat_at_tape_end'] for r in depth_rows) / total_tape * 100:.1f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
