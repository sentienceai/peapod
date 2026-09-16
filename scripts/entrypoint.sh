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
if [ ! -d "$DATA/ingest-out/days" ]; then
  echo "no tape at $DATA/ingest-out — the first cycles will ingest from the chain."
  echo "  To seed it instead, see RAILWAY.md."
fi

exec "$@"
