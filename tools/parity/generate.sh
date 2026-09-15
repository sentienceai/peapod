#!/usr/bin/env bash
#
# Regenerate the v4-core ground-truth fixtures in test/fixtures/.
#
# The vectors these emit are what pin peapod's BigInt engine to canonical Uniswap v4-core.
# If this script cannot run, the engine cannot be re-verified after a change to v4-core or
# to the port — so it resolves every path at run time and refuses to guess.
#
# Required:
#   PEAPOD_LP_TERMINAL   path to the lp-terminal checkout (supplies v4-core and forge-std
#                        as submodules, plus PoolMathHarness.sol)
#
# Optional overrides, for when a dependency no longer lives inside lp-terminal:
#   PEAPOD_V4_CORE       path to a v4-core checkout's src/ directory
#   PEAPOD_FORGE_STD     path to a forge-std checkout's src/ directory
#   PEAPOD_POOL_MATH     path to the directory holding PoolMathHarness.sol
#
# Usage:
#   PEAPOD_LP_TERMINAL=~/lp-terminal ./generate.sh

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixtures="$(cd "$here/../.." && pwd)/test/fixtures"

die() {
  printf '\nparity fixture generation failed:\n  %s\n\n' "$1" >&2
  shift
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
  printf '\n' >&2
  exit 1
}

command -v forge >/dev/null 2>&1 || die \
  "forge is not on PATH." \
  "These fixtures are emitted by canonical v4-core Solidity, so Foundry is required." \
  "Install it: https://getfoundry.sh"

# --- resolve the dependency paths -------------------------------------------------

if [ -z "${PEAPOD_LP_TERMINAL:-}" ] && \
   { [ -z "${PEAPOD_V4_CORE:-}" ] || [ -z "${PEAPOD_FORGE_STD:-}" ] || [ -z "${PEAPOD_POOL_MATH:-}" ]; }; then
  die \
    "PEAPOD_LP_TERMINAL is not set." \
    "It must point at an lp-terminal checkout, which supplies v4-core and forge-std as" \
    "git submodules along with PoolMathHarness.sol:" \
    "" \
    "  PEAPOD_LP_TERMINAL=~/lp-terminal $0" \
    "" \
    "If those dependencies no longer live inside lp-terminal, set all three of" \
    "PEAPOD_V4_CORE, PEAPOD_FORGE_STD and PEAPOD_POOL_MATH instead."
fi

lp="${PEAPOD_LP_TERMINAL:-}"
v4_core="${PEAPOD_V4_CORE:-${lp:+$lp/contracts/lib/v4-core/src}}"
forge_std="${PEAPOD_FORGE_STD:-${lp:+$lp/contracts/lib/forge-std/src}}"
pool_math="${PEAPOD_POOL_MATH:-${lp:+$lp/contracts/src}}"

if [ -n "$lp" ] && [ ! -d "$lp" ]; then
  die "PEAPOD_LP_TERMINAL points at a directory that does not exist:" "  $lp"
fi

# Each dependency is checked by a file the generator actually imports, so a half-
# initialised submodule fails here with a name rather than inside solc.
check() {
  local label="$1" dir="$2" probe="$3" hint="$4"
  [ -n "$dir" ] || die "$label path is empty." "$hint"
  [ -f "$dir/$probe" ] || die \
    "$label is missing $probe." \
    "  looked in: $dir" \
    "$hint"
  ( cd "$dir" && pwd )
}

v4_core="$(check   "v4-core"          "$v4_core"   "libraries/TickMath.sol"  "If the v4-core submodule is not initialised: git -C \"$lp\" submodule update --init --recursive, or set PEAPOD_V4_CORE.")"
forge_std="$(check "forge-std"        "$forge_std" "Test.sol"                "If the forge-std submodule is not initialised: git -C \"$lp\" submodule update --init --recursive, or set PEAPOD_FORGE_STD.")"
pool_math="$(check "PoolMathHarness"  "$pool_math" "PoolMathHarness.sol"     "Set PEAPOD_POOL_MATH to the directory containing PoolMathHarness.sol.")"

printf 'v4-core          %s\n' "$v4_core"
printf 'forge-std        %s\n' "$forge_std"
printf 'PoolMathHarness  %s\n' "$pool_math"
printf 'fixtures         %s\n\n' "$fixtures"

# --- generate ---------------------------------------------------------------------

cd "$here"
forge test --match-contract SweepTest \
  --remappings "v4-core/=$v4_core/" \
  --remappings "forge-std/=$forge_std/" \
  --remappings "lp-terminal/=$pool_math/"

emitted=(tick-sweep.json delta-sweep.json boundary-sweep.json)
for f in "${emitted[@]}"; do
  [ -f "$here/$f" ] || die "forge did not emit $f." "The sweep tests passed but wrote nothing; check fs_permissions in foundry.toml."
done

mkdir -p "$fixtures"
for f in "${emitted[@]}"; do
  mv "$here/$f" "$fixtures/$f"
  printf 'wrote %s\n' "$fixtures/$f"
done

printf '\nNote: positions.json is NOT regenerated here. It comes from lp-terminal\n'
printf '(uv run python engine/build_parity_fixtures.py) and needs an archive RPC.\n'
printf '\nVerify with: npm test\n'
