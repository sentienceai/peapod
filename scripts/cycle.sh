#!/usr/bin/env bash
# One incremental cycle: pull, resolve, price, rebuild, verify, commit.
#
# Everything it calls is already incremental — the swap ingest and the identity resolver
# both hold block cursors, the day partitions are appended to, and the store upserts. This
# only sequences them and refuses to run twice at once.
#
# EXIT CODES. 0 committed, 1 a stage failed, 2 the gates rejected the build, 3 another
# cycle holds the lock. A rejected build is not a crash: the store still serves what it was
# serving, which is the whole point of committing in one transaction.
#
#   scripts/cycle.sh            one cycle
#   CYCLE_SKIP_INGEST=1 …       rebuild from what is already on disk
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# PEAPOD_LP_TERMINAL is optional: the registry is vendored. When it IS set and valid,
# the loaders read the full upstream copy instead of the 1.3 MB subset.
: "${PEAPOD_DB:=$PWD/var/peapod.db}"
export PEAPOD_DB PYTHONPATH="ingest:export"

PY="${PEAPOD_PY:-.venv/bin/python}"
LOCK="var/cycle.lock"
LOG="var/cycle.log"
mkdir -p var

# A lock that survives a kill -9: the pid in it is checked, so a stale file from a crashed
# cycle does not wedge the schedule forever.
if [ -e "$LOCK" ]; then
  other="$(cat "$LOCK" 2>/dev/null || echo 0)"
  if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then
    echo "cycle $other still running; skipping this tick"
    exit 3
  fi
  echo "clearing a stale lock from pid $other"
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

started=$(date +%s)
say() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

stage() {
  local name="$1"; shift
  local t0; t0=$(date +%s)
  say "$name"
  if ! "$@"; then
    say "$name FAILED"
    return 1
  fi
  say "$name done in $(( $(date +%s) - t0 ))s"
}

if [ "${CYCLE_SKIP_INGEST:-0}" != "1" ]; then
  # ORDER IS A DEPENDENCY CHAIN, NOT A PREFERENCE. Each stage consumes what the one above
  # it wrote, and the cycle used to skip the second line entirely: Pons was ingested by a
  # separate one-shot script that nothing ran, so on a cold volume eth/usd reached for a
  # Pons tape that no stage had ever produced and died on an empty directory.
  #
  #   swaps:rwa ─┐
  #   swaps:pons ┴─> identity ─> partitions ─> eth/usd ─> build
  #
  # identity resolves both tapes in one pass, so both must be fetched before it runs.
  # eth/usd prices the Pons window, so it must run after the Pons tape exists.
  #
  # Each of these resumes from its own checkpoint and is a no-op when there is nothing new.
  stage "swaps: rwa"   $PY ingest/swaps_with_tx.py --universe rwa   || exit 1
  stage "swaps: pons"  $PY ingest/swaps_with_tx.py --universe pons  || exit 1
  stage "identity"     $PY ingest/resolve_senders.py --max-hours 0.2 || exit 1
  stage "partitions"   $PY ingest/partitions.py                    || exit 1
  # HOUSEKEEPING, NOT INGEST. Partitioning appends a small part per cycle per day; left
  # alone a day open for 24 hours ends up with ~96 files the reader opens to answer one
  # window. This merges a day once it has collected 24 of them, which is about four times
  # a day per tape, and costs rewriting that one day. It is not allowed to fail the cycle:
  # nothing downstream needs it, and a day with too many parts is slow, not wrong.
  stage "compact days" $PY ingest/partitions.py --compact --min-parts 24 \
                                                                   || say "compaction skipped"
  stage "eth/usd"      $PY ingest/eth_usd.py --stage series        || exit 1
  # SUPPLY IS READ EVERY CYCLE, unlike decimals, which are read once and cached: a
  # Robinhood-issued token is minted on the way in and burned on the way out, so the number
  # moves on its own. One eth_call per token, ~294 of them in 6 batched requests, well under
  # half a second — the stage prints its own count and elapsed time into this log. A failed
  # read is not fatal: the build falls back to the last parquet it wrote and the figures it
  # cannot scale simply do not appear.
  stage "token supply" $PY ingest/token_supply.py                  || say "token supply FAILED; the build will use the last read"
fi

# The build runs the gates and either commits in one transaction or rolls back.
say "build"
if $PY export/build_leaderboard.py --source "${PEAPOD_SOURCE:-edge}"; then
  code=0
else
  code=$?
fi

elapsed=$(( $(date +%s) - started ))
if [ "$code" -eq 0 ]; then
  say "cycle committed in ${elapsed}s"
else
  say "cycle rejected after ${elapsed}s (exit $code); the store still serves the last good build"
  exit 2
fi
