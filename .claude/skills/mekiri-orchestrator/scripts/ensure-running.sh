#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${1:?usage: ensure-running.sh <project-dir>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MEKIRI_HOST_DIR="$(cd "$SCRIPT_DIR/../../../../packages/mekiri-host" && pwd)"

SESSION_DIR="$PROJECT_DIR/.mekiri/live-session"
FIFO="$SESSION_DIR/in.fifo"
LOG="$SESSION_DIR/output.log"
PIDFILE="$SESSION_DIR/pid"

mkdir -p "$SESSION_DIR"

# Liveness must be checked against the real worker process, not the
# `bash -c "tail -f ... | npx tsx ..."` wrapper whose PID lands in $PIDFILE.
# That wrapper never exits on its own: `tail -f` blocks in read() on the FIFO
# and only ever notices a broken pipe on its next write() attempt, so if the
# npx tsx worker on the other end of the pipe crashes (uncaught exception,
# OOM, API error) while the FIFO is quiet, `tail -f` -- and therefore the
# `bash -c` wrapper waiting on the whole pipeline -- keeps running forever,
# even though nothing will ever process messages written to the FIFO again.
# `kill -0 "$(cat "$PIDFILE")"` would report that dead session as "alive".
#
# Instead, match the actual OS argv of the worker directly. By the time the
# `bash -c '...'` string reaches a real process, the shell has stripped the
# single quotes around $PROJECT_DIR, so the running command looks like:
#   node .../tsx/dist/loader.mjs src/index.ts --dir /abs/path (no quotes)
# Anchoring the pattern on this project dir's exact path (regex-escaped, and
# anchored at end of line) keeps two different project dirs' sessions from
# ever being confused with each other.
escape_regex() {
  printf '%s' "$1" | sed -e 's/[][\.^$*]/\\&/g'
}
WORKER_PATTERN="src/index\.ts --dir $(escape_regex "$PROJECT_DIR")\$"

if WORKER_PID="$(pgrep -f "$WORKER_PATTERN" | head -n1)" && [ -n "$WORKER_PID" ]; then
  echo "already running: worker_pid=$WORKER_PID fifo=$FIFO log=$LOG"
  exit 0
fi

[ -p "$FIFO" ] || mkfifo "$FIFO"
: > "$LOG"

(
  cd "$MEKIRI_HOST_DIR"
  nohup bash -c "tail -f '$FIFO' | npx tsx src/index.ts --dir '$PROJECT_DIR'" >> "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
)

# $PIDFILE now records only the tail-f/npx-tsx wrapper PID for diagnostic
# purposes (e.g. to inspect or kill the pipeline manually) -- it is not, and
# must not become, the source of truth for liveness. See WORKER_PATTERN above.
echo "started: wrapper_pid=$(cat "$PIDFILE") fifo=$FIFO log=$LOG"
