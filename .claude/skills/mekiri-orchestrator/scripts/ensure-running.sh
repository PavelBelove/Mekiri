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

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "already running: pid=$(cat "$PIDFILE") fifo=$FIFO log=$LOG"
  exit 0
fi

[ -p "$FIFO" ] || mkfifo "$FIFO"
: > "$LOG"

(
  cd "$MEKIRI_HOST_DIR"
  nohup bash -c "tail -f '$FIFO' | npx tsx src/index.ts --dir '$PROJECT_DIR'" >> "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
)

echo "started: pid=$(cat "$PIDFILE") fifo=$FIFO log=$LOG"
