#!/bin/bash
# Count the tests defined in each suite file.
#
# Run before and after restructuring a test file. A silent deletion — the kind a coarse
# text-slice edit causes when its boundaries are wrong — then shows up as a number rather
# than depending on a type checker happening to notice an orphaned import.
#
#   scripts/test-census.sh            print the census
#   scripts/test-census.sh --update   record it as the new floor
#
# test/counts.test.mjs enforces the floor, so a deletion fails the suite.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

manifest="test/expected-counts.json"
tmp="$(mktemp)"
echo "{" > "$tmp"
first=1
emit() {
  [ $first -eq 0 ] && echo "," >> "$tmp"
  first=0
  printf '  "%s": %s' "$1" "$2" >> "$tmp"
}

for f in test/*.test.mjs; do
  [ -e "$f" ] || continue
  n=$(grep -cE "^test\(" "$f")
  printf "%-42s %3d\n" "$f" "$n"
  emit "$f" "$n"
done
for f in export/test_*.py ingest/test_*.py; do
  [ -e "$f" ] || continue
  n=$(grep -cE "^\s+def test_" "$f")
  printf "%-42s %3d\n" "$f" "$n"
  emit "$f" "$n"
done
printf "\n}\n" >> "$tmp"

if [ "${1:-}" = "--update" ]; then
  mv "$tmp" "$manifest"
  echo
  echo "recorded as the floor in $manifest"
else
  rm -f "$tmp"
fi
