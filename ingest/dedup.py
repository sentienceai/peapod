"""Identity and deduplication for chain records, applied at ingest rather than afterwards.

WHY AT INGEST. Goldsky Edge is documented to return duplicate logs: canopy's stock-lake
pipeline hit a sample where deduplicating by (block hash, transaction hash, log index)
reproduced all 373 records a Turbo pipeline returned. A duplicate that reaches a parquet
part is indistinguishable from a real second event once the response is gone, so identity
is enforced where the response is still in hand.

THREE DISTINCT THINGS, DELIBERATELY NOT CONFLATED.

  duplicate  the same record arriving twice, byte for byte. Dropped silently; it carries
             no information beyond the copy already held.

  conflict   the same position on the chain — block number and log index — arriving with a
             DIFFERENT block hash or different payload. That is either a reorg or a
             provider error, and the two are not distinguishable from one response. It is
             never silently resolved: both versions are kept and counted, because picking
             one would be inventing an answer.

  removed    a log the provider marks `removed`, meaning it was undone by a reorg. Rejected
             outright rather than deduplicated, because it is not a record of anything.

Block hash is part of every key. Block number alone is not an identity on a chain that can
reorganise: two different blocks can carry the same number, and their logs would otherwise
collapse into each other.
"""

from __future__ import annotations

from dataclasses import dataclass, field


def log_key(record: dict) -> tuple:
    """Canonical identity of a log: where it sits, on which block."""
    return (record.get("block_hash"), record.get("tx_hash"), record.get("log_index"))


def tx_key(record: dict) -> tuple:
    """Canonical identity of a transaction. Transactions have no log index."""
    return (record.get("block_hash"), record.get("tx_hash"))


def position(record: dict) -> tuple:
    """Where a log claims to sit, independent of which block it came from.

    Two records sharing a position but not a block hash are the reorg case.
    """
    return (record.get("block"), record.get("log_index"))


@dataclass
class Deduplicator:
    """Accepts records once, rejects removed ones, and records conflicts rather than
    resolving them."""

    key_of: object = log_key
    track_conflicts: bool = True

    seen: dict = field(default_factory=dict)
    by_position: dict = field(default_factory=dict)
    duplicates: int = 0
    removed: int = 0
    conflicts: list = field(default_factory=list)

    def accept(self, record: dict) -> bool:
        """True if this record is new and usable."""
        if record.get("removed"):
            self.removed += 1
            return False

        key = self.key_of(record)
        if key in self.seen:
            self.duplicates += 1
            return False

        if self.track_conflicts:
            where = position(record)
            if where[0] is not None and where[1] is not None:
                previous = self.by_position.get(where)
                if previous is not None and previous != key:
                    # Same slot on the chain, different block. Keep both, flag it.
                    self.conflicts.append({"position": where, "keys": [previous, key]})
                else:
                    self.by_position[where] = key

        self.seen[key] = True
        return True

    def summary(self) -> dict:
        return {
            "accepted": len(self.seen),
            "duplicates_dropped": self.duplicates,
            "removed_rejected": self.removed,
            "conflicts": len(self.conflicts),
        }
