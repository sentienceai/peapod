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


# --- cold start ------------------------------------------------------------------
#
# This stage prices the Pons window, so it reads the Pons tape to find out what that window
# is. On a cold volume there is no Pons tape, and a bare concat over the empty directory
# raised `cannot concat empty list` — a message about the code rather than the situation,
# eleven hours into a deploy with every earlier stage green. Skipping is right: the empty
# Pons scopes are refused by the build gates, so nothing is published on a missing price.

import json

import pytest

import eth_usd


@pytest.fixture
def cold(tmp_path, monkeypatch):
    monkeypatch.setenv("GOLDSKY_EDGE_URL", "http://127.0.0.1:9/edge")
    monkeypatch.setattr(eth_usd, "HERE", tmp_path)
    monkeypatch.setattr(eth_usd, "OUT", tmp_path / "out" / "eth_usd")
    monkeypatch.setattr(eth_usd, "SELECTION", tmp_path / "eth-usd-reference.json")
    monkeypatch.setattr("sys.argv", ["eth_usd.py", "--stage", "series"])
    return tmp_path


def test_an_absent_pons_tape_is_a_skip_not_a_crash(cold, capsys):
    assert eth_usd.main() == 0
    assert "skipping" in capsys.readouterr().out


def test_an_empty_pons_directory_is_a_skip_too(cold, capsys):
    (cold / "out" / "pons_swaps").mkdir(parents=True)
    assert eth_usd.main() == 0
    assert "skipping" in capsys.readouterr().out


def test_a_tape_with_no_chosen_reference_pool_is_a_skip(cold, capsys):
    import polars as pl

    d = cold / "out" / "pons_swaps"
    d.mkdir(parents=True)
    pl.DataFrame({"block": [10, 20]}).write_parquet(d / "part-00000.parquet")
    assert eth_usd.main() == 0
    out = capsys.readouterr().out
    assert "pons window: blocks 10..20" in out
    assert "no reference pool chosen" in out


def test_the_vendored_reference_is_used_when_this_run_has_not_selected_one(cold):
    (cold / "eth-usd-reference.json").write_text(
        json.dumps({"reference": {"pool_id": "0xabc"}, "candidates": [{"pool_id": "0xabc"}]}))
    assert eth_usd.selection()["reference"]["pool_id"] == "0xabc"


def test_the_shipped_reference_is_vendored_and_readable():
    # A container has never run --stage select and never will: the selection is an argmax
    # over executable depth across every ETH/USDG pool, and rerunning it on a schedule
    # would let the reference flip mid-series.
    chosen = json.loads(eth_usd.SELECTION.read_text())
    assert chosen["reference"]["pool_id"].startswith("0x")
    assert any(c["pool_id"] != chosen["reference"]["pool_id"] for c in chosen["candidates"]), \
        "the cross-check needs a second pool to compare against"
