// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {SqrtPriceMath} from "v4-core/libraries/SqrtPriceMath.sol";
import {PoolMathHarness} from "lp-terminal/PoolMathHarness.sol";

/// @notice Emits ground-truth vectors from canonical v4-core for peapod's JS engine.
/// Read-only against lp-terminal's v4-core submodule; writes only into this scratch dir.
contract SweepTest is Test {
    function test_EmitTickSweep() public {
        int24[] memory ticks = _tickSamples();
        string memory out = "{\n  \"source\": \"uniswap/v4-core TickMath.getSqrtPriceAtTick\",\n  \"cases\": [\n";
        for (uint256 i = 0; i < ticks.length; i++) {
            out = string.concat(
                out,
                "    {\"tick\": ", vm.toString(int256(ticks[i])),
                ", \"sqrtPriceX96\": \"", vm.toString(uint256(TickMath.getSqrtPriceAtTick(ticks[i]))), "\"}",
                i + 1 < ticks.length ? ",\n" : "\n"
            );
        }
        out = string.concat(out, "  ]\n}\n");
        vm.writeFile("tick-sweep.json", out);
    }

    function test_EmitDeltaSweep() public {
        int24[] memory ticks = _deltaTicks();
        uint128[5] memory liqs = [uint128(1), 1e6, 168847537090838260, 1e24, type(uint128).max / 2];
        string memory out = "{\n  \"source\": \"uniswap/v4-core SqrtPriceMath.getAmount0Delta / getAmount1Delta\",\n  \"cases\": [\n";
        bool first = true;
        for (uint256 a = 0; a < ticks.length; a++) {
            for (uint256 b = a + 1; b < ticks.length; b++) {
                for (uint256 l = 0; l < liqs.length; l++) {
                    for (uint256 r = 0; r < 2; r++) {
                        out = string.concat(out, first ? "" : ",\n",
                            _case(TickMath.getSqrtPriceAtTick(ticks[a]), TickMath.getSqrtPriceAtTick(ticks[b]), liqs[l], r == 1));
                        first = false;
                    }
                }
            }
        }
        out = string.concat(out, "\n  ]\n}\n");
        vm.writeFile("delta-sweep.json", out);
    }

    function _case(uint160 sa, uint160 sb, uint128 liq, bool up) internal pure returns (string memory) {
        return string.concat(
            "    {\"sqrtA\": \"", vm.toString(uint256(sa)),
            "\", \"sqrtB\": \"", vm.toString(uint256(sb)),
            "\", \"liquidity\": \"", vm.toString(uint256(liq)),
            "\", \"roundUp\": ", up ? "true" : "false",
            ", \"amount0\": \"", vm.toString(SqrtPriceMath.getAmount0Delta(sa, sb, liq, up)),
            "\", \"amount1\": \"", vm.toString(SqrtPriceMath.getAmount1Delta(sa, sb, liq, up)), "\"}"
        );
    }

    /// Range-boundary cases for Pool.modifyLiquidity's three-branch split.
    ///
    /// The branch keys off the stored slot0 `tick`, NOT a sqrt-price comparison. When the
    /// price sits strictly inside its tick and that tick equals tickLower or tickUpper,
    /// the wrong comparison silently returns a different split. positions.json contains no
    /// such case, so a `<` -> `<=` slip survives it. These cases kill it.
    function test_EmitBoundarySweep() public {
        int24[6] memory lowers = [int24(-887220), -156240, -600, -60, 0, 343320];
        int24[3] memory widths = [int24(60), 600, 6000];
        uint128 liq = 168847537090838260;
        string memory out = "{\n  \"source\": \"uniswap/v4-core Pool.modifyLiquidity via lp-terminal PoolMathHarness\",\n  \"cases\": [\n";
        bool first = true;
        for (uint256 i = 0; i < lowers.length; i++) {
            for (uint256 w = 0; w < widths.length; w++) {
                int24 lo = lowers[i];
                int24 hi = lo + widths[w];
                // Probe each branch boundary, and each one again with the price nudged
                // strictly inside its own tick (the case that distinguishes < from <=).
                int24[6] memory probes = [lo - 1, lo, lo + 1, hi - 1, hi, hi + 1];
                for (uint256 k = 0; k < probes.length; k++) {
                    for (uint256 nudge = 0; nudge < 2; nudge++) {
                        out = string.concat(out, first ? "" : ",\n", _bcase(probes[k], lo, hi, liq, nudge == 1));
                        first = false;
                    }
                }
            }
        }
        out = string.concat(out, "\n  ]\n}\n");
        vm.writeFile("boundary-sweep.json", out);
    }

    function _bcase(int24 tick, int24 lo, int24 hi, uint128 liq, bool inside)
        internal
        pure
        returns (string memory)
    {
        uint160 sp = TickMath.getSqrtPriceAtTick(tick);
        if (inside) {
            uint160 next = TickMath.getSqrtPriceAtTick(tick + 1);
            if (next > sp + 1) sp = sp + (next - sp) / 2; // strictly inside [tick, tick+1)
        }
        (int256 a0, int256 a1) = PoolMathHarness.modifyLiquidityDelta(tick, sp, lo, hi, int128(liq));
        (int256 r0, int256 r1) = PoolMathHarness.modifyLiquidityDelta(tick, sp, lo, hi, -int128(liq));
        return string.concat(
            "    {\"tick\": ", vm.toString(int256(tick)),
            ", \"sqrtPriceX96\": \"", vm.toString(uint256(sp)),
            "\", \"tickLower\": ", vm.toString(int256(lo)),
            ", \"tickUpper\": ", vm.toString(int256(hi)),
            ", \"liquidity\": \"", vm.toString(uint256(liq)),
            "\", \"add0\": \"", vm.toString(a0), "\", \"add1\": \"", vm.toString(a1),
            "\", \"remove0\": \"", vm.toString(r0), "\", \"remove1\": \"", vm.toString(r1), "\"}"
        );
    }

    /// Every per-bit multiplier individually, both signs, boundaries, real fixture
    /// ticks and their neighbours, plus a stride across the whole domain.
    function _tickSamples() internal pure returns (int24[] memory) {
        int24[] memory t = new int24[](1000);
        uint256 n = 0;
        int24[9] memory anchors = [int24(0), 1, -1, TickMath.MIN_TICK, TickMath.MIN_TICK + 1, TickMath.MAX_TICK, TickMath.MAX_TICK - 1, -156214, 343323];
        for (uint256 i = 0; i < anchors.length; i++) t[n++] = anchors[i];
        for (uint256 i = 0; i < 20; i++) {
            int24 bit = int24(uint24(1 << i));
            if (bit > TickMath.MAX_TICK) continue;
            t[n++] = bit;
            t[n++] = -bit;
            t[n++] = bit + 1;
            t[n++] = -bit - 1;
        }
        int24 step = 4567;
        for (int24 x = TickMath.MIN_TICK; x < TickMath.MAX_TICK - step && n < 1000; x += step) t[n++] = x;
        int24[] memory outp = new int24[](n);
        for (uint256 i = 0; i < n; i++) outp[i] = t[i];
        return outp;
    }

    function _deltaTicks() internal pure returns (int24[] memory) {
        int24[] memory t = new int24[](8);
        t[0] = TickMath.MIN_TICK + 1;
        t[1] = -400000;
        t[2] = -156214;
        t[3] = -60;
        t[4] = 0;
        t[5] = 60;
        t[6] = 343323;
        t[7] = TickMath.MAX_TICK - 1;
        return t;
    }
}
