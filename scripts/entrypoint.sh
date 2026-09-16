#!/usr/bin/env bash
# Point the writable directories at the volume, report what is on it, then hand over.
#
# A container filesystem does not survive a deploy and the tape must, so ingest/out and
# var are symlinks into the volume.
#
# NOTHING HERE MAY PREVENT THE SERVER FROM STARTING. An empty volume is the normal
# first-boot state; the server comes up, serves an empty state, and the first cycle fills
# it. A previous version of this file counted files with `ls ... | wc -l` under
# `set -eo pipefail`: `ls` exits 2 on a glob that matches nothing, `2>/dev/null` hid the
# message, pipefail propagated the failure through `wc`, and `set -e` killed the script
# before it printed anything or reached exec. The container crash-looped several times a
# second with no error, on a volume that was working perfectly. Diagnostics must not be
# able to take the process down.
# NOT set -e. Every step before exec is preparation or diagnostics, and none of it is
# worth refusing to start for. A container that cannot serve an empty state cannot be
# reached, inspected or repaired — it can only be watched restarting.
set -uo pipefail
DATA="${PEAPOD_DATA:-/data}"
APP="${PEAPOD_APP:-/app}"          # configurable so this script can actually be tested

link_volume() {
  mkdir -p "$DATA/ingest-out" "$DATA/var" || return 1
  rm -rf "$APP/ingest/out" "$APP/var" || return 1
  ln -sfn "$DATA/ingest-out" "$APP/ingest/out" || return 1
  ln -sfn "$DATA/var" "$APP/var" || return 1
}

if ! link_volume; then
  # Loudly, because the consequence is real: the cycle would write to container storage
  # and lose it on the next deploy. But the server still comes up, so the problem can be
  # seen and fixed rather than guessed at from a restart loop.
  echo "WARNING: could not link $DATA into $APP. Check the volume mount." >&2
  echo "WARNING: anything written this run will NOT survive a redeploy." >&2
fi

# Counting with a glob and no pipeline: nothing here can return non-zero.
count_parts() {
  local n=0 f
  for f in "$1"/part-*.parquet; do
    [ -e "$f" ] && n=$((n + 1))
  done
  printf '%s' "$n"
}

count_dirs() {
  local n=0 f
  for f in "$1"/*; do
    [ -d "$f" ] && n=$((n + 1))
  done
  printf '%s' "$n"
}

report() {
  local swaps ident days cursor=""
  swaps=$(count_parts "$DATA/ingest-out/swaps_tx")
  ident=$(count_parts "$DATA/ingest-out/tx_from_edge")
  days=$(count_dirs "$DATA/ingest-out/days")
  if [ -f "$DATA/ingest-out/swaps_tx.checkpoint.json" ]; then
    cursor=$(sed -n 's/.*"cursor": *\([0-9]*\).*/\1/p' \
      "$DATA/ingest-out/swaps_tx.checkpoint.json" 2>/dev/null | head -1) || cursor=""
  fi
  echo "volume: ${swaps} swap parts, ${ident} identity parts, ${days} day partitions${cursor:+, cursor $cursor}"
  [ -e "$APP/var/peapod.db" ] || echo "  no build yet — serving an empty state until the first cycle commits"
  [ "$swaps" != "0" ] || echo "  no swap tape yet — the first cycles ingest from the chain. See RAILWAY.md."
}

# Belt and braces: even a bug in report() must not stop the server.
report || echo "volume: could not be inspected; starting anyway"

# NEVER exec NOTHING. `exec "$@"` with no arguments is a silent no-op: the script ends,
# the container exits 0, and the platform restarts it about once a second having printed
# exactly one line and no error. That is indistinguishable from a crash and it is what a
# container with no CMD reaching the entrypoint actually did. If nothing was passed, start
# the thing this image exists to run.
if [ "$#" -eq 0 ]; then
  echo "entrypoint: no command given; using the default"
  set -- node --experimental-sqlite --no-warnings scripts/run.mjs
fi

# Always say what is being started. The silence was most of the difficulty here.
echo "entrypoint: exec $*"
exec "$@"
