"""The price arithmetic, pinned.

A sign or a decimals error here does not crash: it produces a plausible-looking price that
is wrong by a factor of 10^12, and every ETH-quoted trade in the report inherits it.
"""

from __future__ import annotations

import math

from eth_usd import price_from, signed


def test_price_matches_a_hand_computed_sqrt_price():
    # $2,500 per ETH, ETH as token0 (18 decimals) against USDG (6).
    # sqrtPriceX96 = sqrt(price * 10^(d1-d0)) * 2^96
    target = 2500.0
    sqrt_p = int(math.sqrt(target * 10 ** (6 - 18)) * (1 << 96))
    assert abs(price_from(sqrt_p, eth0=True) - target) < 0.01


def test_the_reciprocal_is_taken_when_eth_is_token1():
    target = 2500.0
    # Same pool with the sort order reversed: USDG is token0, so the raw ratio is
    # ETH per USDG and has to be inverted before decimals are undone.
    sqrt_p = int(math.sqrt((1 / target) * 10 ** (18 - 6)) * (1 << 96))
    assert abs(price_from(sqrt_p, eth0=False) - target) < 0.01


def test_a_zero_price_does_not_divide_by_zero():
    assert price_from(0, eth0=False) == 0.0
    assert price_from(0, eth0=True) == 0.0


def test_the_two_orientations_agree_on_the_same_pool():
    for target in (1200.0, 2500.0, 4321.5):
        a = int(math.sqrt(target * 10 ** (6 - 18)) * (1 << 96))
        b = int(math.sqrt((1 / target) * 10 ** (18 - 6)) * (1 << 96))
        assert abs(price_from(a, True) - price_from(b, False)) < 0.02


def test_abi_words_are_sign_extended_to_256_bits():
    # Reading an int128 at its declared width turns every negative amount into an
    # enormous positive one. This is the bug that produced a tape of giant buys.
    assert signed(2 ** 256 - 1) == -1
    assert signed(2 ** 255) == -(2 ** 255)
    assert signed(0) == 0
    assert signed(12345) == 12345


def test_a_realistic_sqrt_price_from_the_chain_prices_near_the_measured_range():
    # The reference pool's own window ran $2,414 .. $2,627; a value inside it must not
    # decode to something orders of magnitude away.
    sqrt_p = int(math.sqrt(2489.22 * 10 ** (6 - 18)) * (1 << 96))
    px = price_from(sqrt_p, eth0=True)
    assert 2400 < px < 2650, px
