#!/usr/bin/env bash
# Point the writable directories at the volume, then hand over.
#
# A container filesystem does not survive a deploy and the tape must. Rather than teach
# every ingest script an env var for its output directory, ingest/out and var are symlinks
# into /data, which is where the volume is mounted.
set -euo pipefail
DATA="${PEAPOD_DATA:-/data}"

mkdir -p "$DATA/ingest-out" "$DATA/var" "$DATA/registry"
rm -rf /app/ingest/out /app/var
ln -sfn "$DATA/ingest-out" /app/ingest/out
ln -sfn "$DATA/var" /app/var

# The pool and token registry lives outside this repository. It is read every build, so it
# has to be on the volume; seed it once and the container stops caring where it came from.
export PEAPOD_LP_TERMINAL="${PEAPOD_LP_TERMINAL:-$DATA/registry}"
if [ ! -d "$PEAPOD_LP_TERMINAL/out/raw/pools" ]; then
  echo "WARNING: no registry at $PEAPOD_LP_TERMINAL/out/raw/pools"
  echo "  Builds will fail until it is seeded. See RAILWAY.md."
fi

exec "$@"
