#!/usr/bin/env bash
# Point the writable directories at the volume, then hand over.
#
# A container filesystem does not survive a deploy and the tape must. Rather than teach
# every ingest script an env var for its output directory, ingest/out and var are symlinks
# into /data, which is where the volume is mounted.
#
# NOTHING IS REQUIRED TO BE THERE. An empty volume is the normal first-boot state: the
# registry is vendored in the image, the server serves an empty state until a build lands,
# and the first cycle fills it. The container that needed data to start, and needed to
# start to receive data, was a deploy that could not happen.
set -euo pipefail
DATA="${PEAPOD_DATA:-/data}"

mkdir -p "$DATA/ingest-out" "$DATA/var"
rm -rf /app/ingest/out /app/var
ln -sfn "$DATA/ingest-out" /app/ingest/out
ln -sfn "$DATA/var" /app/var

if [ ! -e /app/var/peapod.db ]; then
  echo "no build yet at $DATA/var/peapod.db — serving an empty state until the first cycle"
fi
# Report what is ACTUALLY on the volume. This tested for ingest-out/days, which only the
# partition stage creates — so a volume holding a perfectly good part-written swap tape
# reported "no tape", and three deploys of lost work looked like a volume that was not
# persisting.
swaps=$(ls "$DATA/ingest-out/swaps_tx"/part-*.parquet 2>/dev/null | wc -l | tr -d ' ')
ident=$(ls "$DATA/ingest-out/tx_from_edge"/part-*.parquet 2>/dev/null | wc -l | tr -d ' ')
days=$(ls -d "$DATA/ingest-out/days"/* 2>/dev/null | wc -l | tr -d ' ')
cursor=$(sed -n 's/.*"cursor": *\([0-9]*\).*/\1/p' \
  "$DATA/ingest-out/swaps_tx.checkpoint.json" 2>/dev/null | head -1)
echo "volume: ${swaps:-0} swap parts, ${ident:-0} identity parts, ${days:-0} day partitions${cursor:+, cursor $cursor}"
if [ "${swaps:-0}" = "0" ]; then
  echo "  no swap tape yet — the first cycles will ingest from the chain. See RAILWAY.md."
fi

exec "$@"
