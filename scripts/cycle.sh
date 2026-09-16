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

: "${PEAPOD_LP_TERMINAL:=$HOME/lp-terminal}"
: "${PEAPOD_DB:=$PWD/var/peapod.db}"
export PEAPOD_LP_TERMINAL PEAPOD_DB PYTHONPATH="ingest:export"

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
  # Each of these resumes from its own checkpoint and is a no-op when there is nothing new.
  stage "swaps: rwa"   $PY ingest/swaps_with_tx.py                    || exit 1
  stage "identity"     $PY ingest/resolve_senders.py --max-hours 0.2 || exit 1
  stage "partitions"   $PY ingest/partitions.py                    || exit 1
  stage "eth/usd"      $PY ingest/eth_usd.py --stage series        || exit 1
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
