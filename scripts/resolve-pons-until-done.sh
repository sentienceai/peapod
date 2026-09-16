#!/usr/bin/env bash
# Resume the Pons identity resolution until there is nothing left to resolve.
#
# stage_resolve stops cleanly at --max-hours and checkpoints what it has, which is the
# right behaviour for a single run and the wrong behaviour for a job that has to finish:
# the last two attempts both stopped at their cap and were reported as progress. This
# loops until the stage itself says there are no blocks left, so "done" is the stage's
# own word rather than an inference from a percentage.
#
# Waits on a PID, not a pattern: pgrep -f matching this script's own command line is the
# bug that has already been fixed once here.
set -uo pipefail
cd "$(dirname "$0")/.."

LOG=ingest/out/pons-resolve.log
MAX_ROUNDS=${MAX_ROUNDS:-8}

if [ -n "${WAIT_PID:-}" ]; then
  echo "waiting on the run already in flight (pid $WAIT_PID)"
  while kill -0 "$WAIT_PID" 2>/dev/null; do
    # kill -0 succeeds forever on a zombie, so check the process state too.
    state=$(ps -o state= -p "$WAIT_PID" 2>/dev/null | tr -d ' ')
    case "$state" in Z*|"") break ;; esac
    sleep 20
  done
  echo "in-flight run finished"
fi

for round in $(seq 1 "$MAX_ROUNDS"); do
  remaining=$(PEAPOD_LP_TERMINAL="$HOME/lp-terminal" PYTHONPATH=ingest:export \
    .venv/bin/python - <<'PY'
import json, pathlib, polars as pl
blocks = set(json.loads(pathlib.Path("ingest/out/pons_blocks.json").read_text()))
done = set()
for p in pathlib.Path("ingest/out/tx_from_pons").glob("part-*.parquet"):
    done |= set(pl.read_parquet(p)["block"].to_list())
print(len(blocks - done))
PY
)
  echo "round $round: $remaining blocks outstanding"
  if [ "$remaining" -eq 0 ]; then
    echo "pons resolution complete"
    exit 0
  fi
  PEAPOD_LP_TERMINAL="$HOME/lp-terminal" PYTHONPATH=ingest:export \
    PEAPOD_RPC_BATCH=200 PEAPOD_RPC_PACE=2.0 \
    .venv/bin/python -u ingest/pons_probe.py --stage resolve --max-hours 4 >> "$LOG" 2>&1
done
echo "stopped after $MAX_ROUNDS rounds with work outstanding" >&2
exit 1
