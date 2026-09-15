"""Calculator precompute: what a position would have earned, as a distribution.

THE SHAPE OF THE PROBLEM. The calculator takes a pool, a range and a position size and
returns fees minus impermanent loss versus holding. Two facts about that calculation decide
the whole design:

  1. The IL / price-path term is SIZE-INDEPENDENT as a percentage of capital. Position value
     and the hold benchmark are both linear in L, and L is linear in notional, so the ratio
     does not move with size. It can be precomputed once per (pool, range, window).

  2. Fees are the only size-dependent term, and depend on size only through the pro-rata
     share L/(L + active). So the fee side reduces to sums of g * kN/(kN + A) over swap
     segments, where g is the segment's gross fee in dollars and A its active liquidity.

Point 2 is what makes a browser calculator possible without shipping the tape. Segments are
grouped by active liquidity into buckets, and each bucket ships its fee total G and a
representative A. The browser evaluates sum(G * L/(L + A)) -- the SAME functional form as
the exact sum, not a curve fitted to it, so the only approximation is replacing the A
values inside a bucket with one representative. That representative is the fee-weighted
harmonic mean, which makes a bucket exact as L -> 0 and as L -> infinity; error appears
only in the middle, and only to second order in bucket width.

Bucket width is chosen PER WINDOW rather than fixed. The precompute can measure its own
error -- it holds the exact sum -- so it narrows the buckets until the worst relative error
across the position-size range is under a tenth of a percent, then ships that measured
bound with them. Most windows settle at a handful of buckets; a window with a complicated
book pays for its own complexity instead of every window paying for it.

Two earlier designs were measured against real pool segments and discarded: fixed 2x
buckets (1.1% worst error, too coarse in the middle of the size range) and shipping the
curve sampled on a size grid with log-log interpolation (0.37% at 41 points per window --
both less accurate and larger than this).

THE FEE MODEL IS fee_attribution.py, as chosen. That means per-swap tick splitting: a swap
crossing initialized ticks has different active liquidity either side of each crossing, and
a position earns only on the segments its range overlaps. lp-terminal's own
split_swap_at_ticks scans the entire tick map per swap, which is unusable over 2.4M swaps,
so the splitting here uses a sorted-array bisect instead. test_windows.py asserts the two
produce identical segments; the model is theirs, only the lookup is faster.

RANGES SNAP. A range the precompute does not cover is snapped to the nearest covered width
and the UI says so. Interpolating between widths would be inventing a number.
"""

from __future__ import annotations

import bisect
import math

import numpy as np
import polars as pl

from tapes import Q96, sane_mask, ticks_for_pct

FEE_DENOMINATOR = 1_000_000
WIDTHS = {"pm5": 0.05, "pm10": 0.10, "pm25": 0.25}
HOLDING_DAYS = (7, 30)
STEP_DAYS = 3
MIN_WINDOWS = 3
# Position sizes the kernel is certified over. Geometric $100 -> $10M; outside this range
# the kernel is still evaluable, it is simply not error-checked there.
SIZE_GRID = [100.0 * (2.0 ** (i / 2)) for i in range(34)]
# Bucket widths tried in order, in octaves of active liquidity. Coarse first: most windows
# are simple, and should not ship 40 buckets for a book that has four levels.
BUCKET_OCTAVES = (1.0, 0.5, 0.25, 0.125, 0.0625)
TARGET_REL_ERROR = 1e-3


def _crossed(ticks_sorted: list[int], lo: int, hi: int) -> list[int]:
    """Initialized ticks t with lo < t <= hi, by bisect rather than a full scan."""
    left = bisect.bisect_right(ticks_sorted, lo)
    right = bisect.bisect_right(ticks_sorted, hi)
    return ticks_sorted[left:right]


def split_swap(lm, tick_start, sqrt_start, tick_end, sqrt_end, ticks_sorted, net, liquidity_start):
    """fee_attribution.split_swap_at_ticks, with a bisect in place of the linear scan.

    Returns [(sqrt_lo, sqrt_hi, active_liquidity)] in traversal order.
    """
    going_up = sqrt_end > sqrt_start
    lo_t, hi_t = (tick_start, tick_end) if going_up else (tick_end, tick_start)
    crossed = _crossed(ticks_sorted, lo_t, hi_t)
    if not going_up:
        crossed = crossed[::-1]

    segments = []
    cur_sqrt = sqrt_start
    cur_liq = liquidity_start
    for t in crossed:
        boundary = lm.get_sqrt_price_at_tick(t)
        if going_up and not (cur_sqrt < boundary <= sqrt_end):
            continue
        if not going_up and not (sqrt_end <= boundary < cur_sqrt):
            continue
        lo, hi = (cur_sqrt, boundary) if going_up else (boundary, cur_sqrt)
        segments.append((lo, hi, cur_liq))
        cur_liq += net[t] if going_up else -net[t]
        cur_sqrt = boundary
    if cur_sqrt != sqrt_end:
        lo, hi = (cur_sqrt, sqrt_end) if going_up else (sqrt_end, cur_sqrt)
        segments.append((lo, hi, cur_liq))
    return segments


def segments_for_pool(lm, fee_attr, group: pl.DataFrame, mods: pl.DataFrame, anchor_block: int):
    """Replay a pool and emit one row per swap segment.

    Returns (ts, sqrt_lo, sqrt_hi, active_liquidity, gross_fee_usd) as float arrays, plus a
    count of swaps whose replayed liquidity disagreed with the chain's own reading.
    """
    px = group["px"].to_numpy()
    ok = sane_mask(px)
    ts = group["ts"].to_numpy()
    blocks = group["block"].to_numpy().astype(np.int64)
    logidx = group["log_index"].to_numpy().astype(np.int64)
    ticks = group["tick"].to_numpy().astype(np.int64)
    sqrts = [int(x) for x in group["sqrt_price_x96"].to_list()]
    liqs = [int(x) for x in group["liquidity"].to_list()]
    fees = group["fee"].to_numpy().astype(np.int64)

    d0 = int(group["d0"][0] or 18)
    d1 = int(group["d1"][0] or 18)
    rwa0 = bool(group["rwa_is_0"][0])

    mb = mods["block"].to_numpy().astype(np.int64)
    ml = mods["log_index"].to_numpy().astype(np.int64)
    mtl = mods["tick_lower"].to_numpy().astype(np.int64)
    mtu = mods["tick_upper"].to_numpy().astype(np.int64)
    mdl = [int(x) for x in mods["liquidity_delta"].to_list()]

    net: dict[int, int] = {}
    ticks_sorted: list[int] = []
    cursor = 0
    dirty = False

    out_ts, out_lo, out_hi, out_act, out_fee = [], [], [], [], []
    mismatches = 0
    prev_tick = None
    prev_sqrt = None

    for i in range(len(group)):
        if blocks[i] > anchor_block:
            break
        b, l = int(blocks[i]), int(logidx[i])
        while cursor < len(mb) and (mb[cursor] < b or (mb[cursor] == b and ml[cursor] < l)):
            tl, tu, dl = int(mtl[cursor]), int(mtu[cursor]), mdl[cursor]
            if dl:
                net[tl] = net.get(tl, 0) + dl
                net[tu] = net.get(tu, 0) - dl
                dirty = True
            cursor += 1
        if dirty:
            ticks_sorted = sorted(t for t, v in net.items() if v != 0)
            dirty = False

        tick_now, sqrt_now, L_after = int(ticks[i]), sqrts[i], liqs[i]
        if not ok[i] or sqrt_now <= 0:
            prev_tick, prev_sqrt = tick_now, sqrt_now
            continue

        if prev_tick is None:
            # First usable swap: take the chain's reading as the starting state.
            prev_tick, prev_sqrt = tick_now, sqrt_now
            continue

        L_before = sum(v for t, v in net.items() if t <= prev_tick and v != 0)
        segs = split_swap(lm, prev_tick, prev_sqrt, tick_now, sqrt_now,
                          ticks_sorted, net, L_before)

        # The chain publishes post-swap active liquidity. Check the replay against it.
        L_end = segs[-1][2] if segs else L_before
        if tick_now != prev_tick:
            crossed = _crossed(ticks_sorted, min(prev_tick, tick_now), max(prev_tick, tick_now))
            L_end = L_before + sum(net[t] * (1 if tick_now > prev_tick else -1) for t in crossed)
        if L_end != L_after:
            mismatches += 1

        zero_for_one = sqrt_now < prev_sqrt
        fee_pips = int(fees[i])
        price = float(px[i])
        # The input token is the one entering the pool: token0 when the price falls.
        in_is_rwa = rwa0 if zero_for_one else not rwa0
        in_decimals = d0 if zero_for_one else d1

        for sqrt_lo, sqrt_hi, active in segs:
            if active <= 0 or sqrt_lo == sqrt_hi:
                continue
            if zero_for_one:
                net_in = lm.get_amount0_delta(sqrt_lo, sqrt_hi, active, True)
            else:
                net_in = lm.get_amount1_delta(sqrt_lo, sqrt_hi, active, True)
            gross = fee_attr.gross_amount_in(net_in, fee_pips)
            fee_tokens = (gross * fee_pips) // FEE_DENOMINATOR
            if fee_tokens <= 0:
                continue
            amount = fee_tokens / 10 ** in_decimals
            fee_usd = amount * price if in_is_rwa else amount
            if not math.isfinite(fee_usd) or fee_usd <= 0:
                continue
            out_ts.append(ts[i])
            out_lo.append(float(sqrt_lo))
            out_hi.append(float(sqrt_hi))
            out_act.append(float(active))
            out_fee.append(fee_usd)

        prev_tick, prev_sqrt = tick_now, sqrt_now

    return (np.array(out_ts, dtype=np.int64), np.array(out_lo), np.array(out_hi),
            np.array(out_act), np.array(out_fee), mismatches)


# Position sizes the fee curve is evaluated at. Geometric from $100 to $10M; the browser
# interpolates between them in log-log space and the tests bound that error.
def _bucket(active: np.ndarray, fee_usd: np.ndarray, octaves: float):
    exponent = np.floor(np.log2(active) / octaves).astype(np.int64)
    exponent -= exponent.min()
    totals = np.bincount(exponent, weights=fee_usd)
    reciprocal = np.bincount(exponent, weights=fee_usd / active)
    nonempty = np.nonzero(totals > 0)[0]
    # G / sum(g/A) is the fee-weighted harmonic mean of A within the bucket.
    return totals[nonempty], totals[nonempty] / reciprocal[nonempty]


def fee_kernel(active: np.ndarray, fee_usd: np.ndarray, liquidity_per_dollar: float,
               target: float = TARGET_REL_ERROR):
    """Bucket a window's segments, narrowing until the error is certified under target.

    Returns (bucket_fee_totals, bucket_active_representatives, total_fee_usd,
             certified_max_relative_error).
    """
    if len(active) == 0 or liquidity_per_dollar <= 0:
        return [], [], 0.0, 0.0
    positive = active > 0
    active, fee_usd = active[positive], fee_usd[positive]
    if len(active) == 0:
        return [], [], 0.0, 0.0

    total = float(fee_usd.sum())
    liquidities = [liquidity_per_dollar * size for size in SIZE_GRID]
    truth = [exact_fees(active, fee_usd, L) for L in liquidities]

    best = None
    for octaves in BUCKET_OCTAVES:
        totals, representatives = _bucket(active, fee_usd, octaves)
        worst = 0.0
        for L, want in zip(liquidities, truth):
            if want <= 0:
                continue
            got = float((totals * L / (L + representatives)).sum())
            worst = max(worst, abs(got - want) / want)
        best = ([float(x) for x in totals], [float(x) for x in representatives], total, worst)
        if worst <= target:
            break
    return best


def evaluate_kernel(totals, representatives, position_liquidity: float) -> float:
    """What the browser will compute. Kept here so the tests exercise the real thing."""
    return sum(g * position_liquidity / (position_liquidity + a)
               for g, a in zip(totals, representatives))


def exact_fees(active: np.ndarray, fee_usd: np.ndarray, position_liquidity: float) -> float:
    """The unbucketed sum, for checking the kernel against."""
    if len(active) == 0:
        return 0.0
    return float((fee_usd * position_liquidity / (position_liquidity + active)).sum())


def snap_range(tick: int, spacing: int, half_pct: float | None) -> tuple[int, int] | None:
    """The tick range a pool can actually hold for a +/-half_pct band around `tick`.

    Snapping is outward, as range_backtest.py does it, so the position covers at least the
    band asked for. A pool whose tick spacing is coarser than the half-width cannot express
    the range at all and returns None -- widening it silently would answer a different
    question than the user asked.
    """
    min_t = math.ceil(-887272 / spacing) * spacing
    max_t = math.floor(887272 / spacing) * spacing
    if half_pct is None:
        return min_t, max_t
    w = ticks_for_pct(half_pct)
    if spacing > w:
        return None
    lo = max(math.floor((tick - w) / spacing) * spacing, min_t)
    hi = min(math.ceil((tick + w) / spacing) * spacing, max_t)
    return (lo, hi) if lo < hi else None


def _value(lm, tick, sqrt_p, lo, hi, L, d0, d1, rwa0, price):
    a0, a1 = lm.position_amounts(tick, sqrt_p, lo, hi, L)
    rwa = (a0 / 10 ** d0) if rwa0 else (a1 / 10 ** d1)
    usd = (a1 / 10 ** d1) if rwa0 else (a0 / 10 ** d0)
    return rwa, usd, rwa * price + usd


def build_windows(lm, group: pl.DataFrame, segments, spacing: int, anchor_ts: int) -> list[dict]:
    """Every (width, holding period, start) window for one pool.

    The IL term is computed once per window and reported as a percentage of capital,
    because it does not depend on position size. The fee term is a kernel, because it does.
    """
    seg_ts, seg_lo, seg_hi, seg_act, seg_fee = segments
    px = group["px"].to_numpy()
    ok = sane_mask(px)
    usable = np.nonzero(ok)[0]
    if len(usable) < 2 or len(seg_ts) == 0:
        return []

    ts = group["ts"].to_numpy()[usable]
    ticks = group["tick"].to_numpy().astype(np.int64)[usable]
    sqrts = [int(x) for x in group["sqrt_price_x96"].to_list()]
    sqrts = [sqrts[i] for i in usable]
    prices = px[usable]
    d0 = int(group["d0"][0] or 18)
    d1 = int(group["d1"][0] or 18)
    rwa0 = bool(group["rwa_is_0"][0])
    probe = 10 ** 18

    out: list[dict] = []
    for name, half_pct in [("full", None)] + [(k, v) for k, v in WIDTHS.items()]:
        for days in HOLDING_DAYS:
            span = days * 86400
            starts = np.arange(int(ts[0]), anchor_ts - span + 1, STEP_DAYS * 86400)
            if len(starts) < MIN_WINDOWS:
                continue
            for start_ts in starts:
                i = int(np.searchsorted(ts, start_ts, "left"))
                j = int(np.searchsorted(ts, start_ts + span, "right")) - 1
                if j <= i:
                    continue
                rng = snap_range(int(ticks[i]), spacing, half_pct)
                if rng is None:
                    break                       # this pool cannot express this width at all
                lo_t, hi_t = rng

                _, _, unit = _value(lm, int(ticks[i]), sqrts[i], lo_t, hi_t, probe,
                                    d0, d1, rwa0, float(prices[i]))
                if unit <= 0:
                    continue
                k = probe / unit                # position liquidity per dollar of capital
                L_one = int(k)                  # one dollar of capital
                if L_one <= 0:
                    continue

                rwa_init, usd_init, value_start = _value(
                    lm, int(ticks[i]), sqrts[i], lo_t, hi_t, L_one, d0, d1, rwa0, float(prices[i]))
                if value_start <= 0:
                    continue
                _, _, pos_end = _value(lm, int(ticks[j]), sqrts[j], lo_t, hi_t, L_one,
                                       d0, d1, rwa0, float(prices[j]))
                hodl_end = rwa_init * float(prices[j]) + usd_init
                if hodl_end <= 0:
                    continue

                sqrt_lo_t = float(lm.get_sqrt_price_at_tick(lo_t))
                sqrt_hi_t = float(lm.get_sqrt_price_at_tick(hi_t))
                mask = ((seg_ts >= start_ts) & (seg_ts <= start_ts + span)
                        & (seg_lo < sqrt_hi_t) & (seg_hi > sqrt_lo_t))
                totals, reps, total_fee, certified = fee_kernel(seg_act[mask], seg_fee[mask], k)

                in_range = ticks[i:j + 1]
                out.append({
                    "width": name,
                    "days": days,
                    "start_ts": int(start_ts),
                    "end_ts": int(ts[j]),
                    "tick_lower": lo_t,
                    "tick_upper": hi_t,
                    "price_start": float(prices[i]),
                    "price_end": float(prices[j]),
                    "liquidity_per_dollar": k,
                    # Size-independent: position value at end, and the hold benchmark,
                    # both per dollar of starting capital.
                    "position_end_per_dollar": pos_end / value_start,
                    "hodl_end_per_dollar": hodl_end / value_start,
                    "il_vs_hodl_pct": (pos_end - hodl_end) / value_start * 100,
                    "time_in_range_pct": float(((in_range >= lo_t) & (in_range < hi_t)).mean() * 100),
                    "fee_kernel_totals": totals,
                    "fee_kernel_active": reps,
                    "fees_total_usd": total_fee,
                    "kernel_max_rel_error": certified,
                    "swaps": int(j - i + 1),
                })
    return out
