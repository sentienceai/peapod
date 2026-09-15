"""Gates on record identity at ingest.

Goldsky Edge is documented to return duplicate logs, so this is not a hypothetical. These
tests fix the three behaviours that have to stay distinct: a byte-identical repeat is
dropped, a reorg-removed log is rejected, and two records claiming the same slot on
different blocks are recorded as a conflict rather than silently collapsed into one.

Usage:  PEAPOD_LP_TERMINAL=~/lp-terminal PYTHONPATH=ingest uv run pytest ingest/
"""

from __future__ import annotations

import unittest

from dedup import Deduplicator, log_key, position, tx_key


def log(block=100, log_index=1, block_hash="0xaaa", tx_hash="0xt1", removed=False):
    return {"block": block, "log_index": log_index, "block_hash": block_hash,
            "tx_hash": tx_hash, "removed": removed}


class Identity(unittest.TestCase):
    def test_block_hash_is_part_of_the_key(self):
        # Block number is not an identity on a chain that can reorganise: two different
        # blocks can carry the same number, and their logs must not collapse together.
        a = log(block_hash="0xaaa")
        b = log(block_hash="0xbbb")
        self.assertNotEqual(log_key(a), log_key(b))
        self.assertEqual(position(a), position(b))

    def test_transactions_are_keyed_without_a_log_index(self):
        self.assertEqual(tx_key({"block_hash": "0xaaa", "tx_hash": "0xt1"}), ("0xaaa", "0xt1"))


class Dedup(unittest.TestCase):
    def test_an_identical_repeat_is_dropped(self):
        d = Deduplicator()
        self.assertTrue(d.accept(log()))
        self.assertFalse(d.accept(log()))
        self.assertEqual(d.summary()["accepted"], 1)
        self.assertEqual(d.summary()["duplicates_dropped"], 1)

    def test_distinct_logs_in_one_transaction_both_survive(self):
        # A multi-leg swap is several logs under one transaction hash. Deduplicating on
        # the transaction alone would silently delete legs.
        d = Deduplicator()
        self.assertTrue(d.accept(log(log_index=1)))
        self.assertTrue(d.accept(log(log_index=2)))
        self.assertEqual(d.summary()["accepted"], 2)
        self.assertEqual(d.summary()["duplicates_dropped"], 0)

    def test_a_removed_log_is_rejected_not_deduplicated(self):
        # A log undone by a reorg is not a record of anything, so it never enters the set
        # and does not suppress a later genuine log at the same position.
        d = Deduplicator()
        self.assertFalse(d.accept(log(removed=True)))
        self.assertEqual(d.summary()["removed_rejected"], 1)
        self.assertEqual(d.summary()["accepted"], 0)
        self.assertTrue(d.accept(log(removed=False)))

    def test_same_position_on_a_different_block_is_a_conflict_not_a_duplicate(self):
        # The reorg case. Both are kept and the disagreement is recorded, because one
        # response cannot tell you which block won.
        d = Deduplicator()
        self.assertTrue(d.accept(log(block_hash="0xaaa")))
        self.assertTrue(d.accept(log(block_hash="0xbbb")))
        summary = d.summary()
        self.assertEqual(summary["accepted"], 2)
        self.assertEqual(summary["duplicates_dropped"], 0)
        self.assertEqual(summary["conflicts"], 1)
        self.assertEqual(d.conflicts[0]["position"], (100, 1))

    def test_a_clean_stream_records_no_conflicts(self):
        d = Deduplicator()
        for i in range(50):
            self.assertTrue(d.accept(log(block=i, log_index=0, tx_hash=f"0xt{i}")))
        self.assertEqual(d.summary(), {"accepted": 50, "duplicates_dropped": 0,
                                       "removed_rejected": 0, "conflicts": 0})

    def test_the_canopy_failure_shape_is_handled(self):
        # The observed case: a provider returned every record twice. Deduplicating by
        # (block hash, tx hash, log index) must reproduce the original set exactly.
        original = [log(block=b, log_index=i, tx_hash=f"0x{b}_{i}")
                    for b in range(20) for i in range(3)]
        d = Deduplicator()
        kept = [r for r in original + original if d.accept(r)]
        self.assertEqual(len(kept), len(original))
        self.assertEqual([log_key(r) for r in kept], [log_key(r) for r in original])
        self.assertEqual(d.summary()["duplicates_dropped"], len(original))

    def test_transaction_mode_does_not_invent_conflicts(self):
        # Transactions have no log index, so position tracking is meaningless for them.
        d = Deduplicator(key_of=tx_key, track_conflicts=False)
        self.assertTrue(d.accept({"block_hash": "0xaaa", "tx_hash": "0xt1", "block": 1}))
        self.assertFalse(d.accept({"block_hash": "0xaaa", "tx_hash": "0xt1", "block": 1}))
        self.assertTrue(d.accept({"block_hash": "0xaaa", "tx_hash": "0xt2", "block": 1}))
        self.assertEqual(d.summary()["conflicts"], 0)
        self.assertEqual(d.summary()["accepted"], 2)


class WiredIn(unittest.TestCase):
    def test_both_ingests_dedup_at_the_point_of_ingest(self):
        import pathlib
        here = pathlib.Path(__file__).resolve().parent
        for name, key in [("swaps_with_tx.py", "log_key"), ("resolve_senders.py", "tx_key")]:
            source = (here / name).read_text()
            self.assertIn("Deduplicator", source, f"{name} does not deduplicate")
            self.assertIn(key, source, f"{name} uses the wrong identity")
            self.assertIn("seen.accept(", source, f"{name} does not apply it while ingesting")

    def test_the_swap_ingest_captures_block_hash_and_removed(self):
        import pathlib
        source = (pathlib.Path(__file__).resolve().parent / "swaps_with_tx.py").read_text()
        self.assertIn('"block_hash": log.get("blockHash")', source)
        self.assertIn('"removed": bool(log.get("removed", False))', source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
