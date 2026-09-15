#!/bin/bash
# Wait for a long-running ingest to exit, by PID rather than by command-line pattern.
#
# WHY NOT pgrep -f. A waiter written as
#
#     until ! pgrep -f "python.*resolve_senders"; do sleep 15; done
#
# matches ITSELF: the shell running that loop has the pattern in its own command line, and
# so does any wrapper that spawned it. The loop therefore never exits, and it fails silently
# — indistinguishable from a job that is still working. This bit twice in one session, once
# holding for 13 minutes before anyone checked, and once nearly blocking a 2.7-hour run from
# starting at all.
#
# `kill -0 PID` asks the kernel whether a specific process exists. It cannot match a
# watcher, a wrapper, an editor with the file open, or a grep of the log.
#
# Usage:  scripts/wait-for-pid.sh <pidfile> [poll_seconds]
# Exit:   0 once the process is gone (or was never running); 2 on a malformed pidfile.

set -uo pipefail

pidfile="${1:?usage: wait-for-pid.sh <pidfile> [poll_seconds]}"
poll="${2:-15}"

if [ ! -f "$pidfile" ]; then
  echo "no pidfile at $pidfile; treating as not running"
  exit 0
fi

pid="$(tr -d '[:space:]' < "$pidfile")"
if ! [[ "$pid" =~ ^[0-9]+$ ]]; then
  echo "pidfile $pidfile does not contain a pid: '$pid'" >&2
  exit 2
fi

# `kill -0` alone is not enough: a process whose parent has not reaped it stays in the
# process table as a zombie, and kill -0 succeeds on a zombie forever. Check the state too,
# so an unreaped child reads as finished rather than as still working.
running() {
  kill -0 "$1" 2>/dev/null || return 1
  local state
  state="$(ps -o state= -p "$1" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$state" ] || return 1
  case "$state" in
    Z*) return 1 ;;
    *)  return 0 ;;
  esac
}

if ! running "$pid"; then
  echo "pid $pid is not running"
  exit 0
fi

echo "waiting on pid $pid (from $pidfile)"
while running "$pid"; do
  sleep "$poll"
done
echo "pid $pid exited"
