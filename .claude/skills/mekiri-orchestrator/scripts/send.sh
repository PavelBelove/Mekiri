#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${1:?usage: send.sh <project-dir> <message>}"
MESSAGE="${2:?usage: send.sh <project-dir> <message>}"
FIFO="$PROJECT_DIR/.mekiri/live-session/in.fifo"

if [ ! -p "$FIFO" ]; then
  echo "no live session fifo at $FIFO -- run ensure-running.sh first" >&2
  exit 1
fi

echo "$MESSAGE" >> "$FIFO"
