"""Gates on the JSON the site actually ships.

The modules upstream of this are tested on their own terms. These tests read the emitted
files the way a browser would, and check the things that would make the site wrong rather
than merely broken: a depth figure travelling without the anchor that dates it, the flat-L
basis described as a ceiling when it is not one, a fee kernel that does not reproduce the
fees it was built from, or a NaN where a number should be.

Skipped when web/data has not been built.
"""

from __future__ import annotations

import json
import math
import unittest
from pathlib import Path

import windows as W

DATA = Path(__file__).resolve().parent.parent / "web" / "data"
TOP_LEVEL = ["meta.json", "pools.json", "depth.json", "windows.json"]


def load(name):
    return json.loads((DATA / name).read_text())


@unittest.skipUnless((DATA / "windows.json").exists(), "web/data not built")
class ShippedFiles(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = {name: load(name) for name in TOP_LEVEL}

    def test_every_file_carries_the_same_provenance(self):
        # These files get downloaded and quoted individually. One without its provenance
        # is a number with no date and no caveats attached.
        blocks = [f["provenance"] for f in self.files.values()]
        for block in blocks[1:]:
            self.assertEqual(block, blocks[0])

    def test_both_anchors_are_published(self):
        anchors = self.files["meta.json"]["provenance"]["anchors"]
        for key in ("executable_depth_anchor", "swap_tape_end"):
            self.assertIn(key, anchors)
            for field in ("block", "ts", "iso", "why"):
                self.assertIn(field, anchors[key])
        # The executable anchor is the older of the two, and the gap is stated.
        self.assertLess(anchors["executable_depth_anchor"]["ts"], anchors["swap_tape_end"]["ts"])
        self.assertGreater(anchors["staleness_hours"], 0)

    def test_the_flat_basis_is_not_called_an_upper_bound(self):
        flat = self.files["meta.json"]["provenance"]["depth_bases"]["flat"]
        caveat = flat["caveat"].lower()
        self.assertIn("not an upper bound", caveat)
        self.assertIn("both directions", caveat)
        # And the same warning travels in the caveat list every file carries.
        caveats = " ".join(self.files["depth.json"]["provenance"]["caveats"]).lower()
        self.assertIn("errs in both directions", caveats)

    def test_the_subsidy_caveat_travels_with_every_file(self):
        for name, payload in self.files.items():
            joined = " ".join(payload["provenance"]["caveats"])
            self.assertIn("2026-09-29", joined, f"{name} lost the gas-subsidy caveat")

    def test_the_fee_model_is_named(self):
        model = self.files["meta.json"]["provenance"]["fee_model"]
        self.assertEqual(model["name"], "fee_attribution.py")
        self.assertIn("tick splitting", model["what"])
        self.assertIn("price_taker", model)

    def test_every_pool_reports_both_depth_bases(self):
        for pool in self.files["depth.json"]["pools"]:
            for field in ("depth_executable", "depth_flat", "depth_flat_at_tape_end",
                          "median_7d_executable", "pct_of_median_executable",
                          "share_of_chain_executable_pct", "volume_per_day_usd"):
                self.assertIn(field, pool, f"{pool['ticker']} missing {field}")
            self.assertGreater(pool["samples"], 0)

    def test_shares_sum_to_one_hundred(self):
        pools = self.files["depth.json"]["pools"]
        self.assertAlmostEqual(sum(p["share_of_chain_executable_pct"] for p in pools), 100.0, places=6)
        self.assertAlmostEqual(sum(p["share_of_chain_flat_pct"] for p in pools), 100.0, places=6)

    def test_no_nan_anywhere(self):
        def walk(node, path):
            if isinstance(node, dict):
                for k, v in node.items():
                    walk(v, f"{path}.{k}")
            elif isinstance(node, list):
                for i, v in enumerate(node):
                    walk(v, f"{path}[{i}]")
            elif isinstance(node, float):
                self.assertTrue(math.isfinite(node), f"non-finite at {path}")
        for name, payload in self.files.items():
            walk(payload, name)

    def test_columnar_arrays_line_up(self):
        index = self.files["windows.json"]
        columns = index["columns"]
        lengths = {name: len(values) for name, values in columns.items()}
        self.assertEqual(len(set(lengths.values())), 1, f"ragged columns: {lengths}")
        self.assertEqual(next(iter(lengths.values())), index["count"])
        self.assertTrue(all(0 <= i < len(index["pools"]) for i in columns["pool_id"]))
        self.assertTrue(all(0 <= i < len(index["widths"]) for i in columns["width"]))

    def test_every_pool_with_windows_has_a_kernel_file(self):
        index = self.files["windows.json"]
        for pool_id in {index["pools"][i] for i in index["columns"]["pool_id"]}:
            self.assertTrue((DATA / "windows" / f"{pool_id}.json").exists(),
                            f"no kernel file for {pool_id}")

    def test_kernels_reproduce_their_own_totals(self):
        index = self.files["windows.json"]
        checked = 0
        for pool_id in index["pools"][:12]:
            kernels = load(f"windows/{pool_id}.json")
            for slot, totals, reps, k in zip(kernels["window_index"],
                                             kernels["fee_kernel_totals"],
                                             kernels["fee_kernel_active"],
                                             kernels["liquidity_per_dollar"]):
                if not totals:
                    continue
                expected = index["columns"]["fees_total_usd"][slot]
                # As position size runs away, the position earns every fee in the window.
                huge = W.evaluate_kernel(totals, reps, k * 1e18)
                self.assertAlmostEqual(huge / expected, 1.0, places=4)
                # And at a vanishing size it is linear in size.
                small = W.evaluate_kernel(totals, reps, k * 1e-9)
                smaller = W.evaluate_kernel(totals, reps, k * 1e-10)
                self.assertAlmostEqual(small / smaller, 10.0, places=3)
                checked += 1
        self.assertGreater(checked, 50, "barely checked any kernels")

    def test_certified_kernel_error_is_within_target(self):
        for value in self.files["windows.json"]["columns"]["kernel_max_rel_error"]:
            self.assertLessEqual(value, W.TARGET_REL_ERROR * 1.0001)

    def test_windows_never_claim_a_width_a_pool_cannot_express(self):
        index = self.files["windows.json"]
        expressible = {p["pool_id"]: set(p["expressible_widths"])
                       for p in self.files["pools.json"]["pools"]}
        for pool_slot, width_slot in zip(index["columns"]["pool_id"], index["columns"]["width"]):
            pool_id = index["pools"][pool_slot]
            self.assertIn(index["widths"][width_slot], expressible[pool_id])

    def test_time_in_range_is_a_percentage(self):
        for value in self.files["windows.json"]["columns"]["time_in_range_pct"]:
            self.assertGreaterEqual(value, 0.0)
            self.assertLessEqual(value, 100.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
