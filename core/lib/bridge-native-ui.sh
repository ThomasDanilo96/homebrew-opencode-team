#!/bin/bash
# Native-UI-only bridge: deliberately never creates tmux worker panes.
set -uo pipefail

SERVER_URL=${OPENCODE_SERVER_URL:?OPENCODE_SERVER_URL required}
RUN_STATE_DIR=${RUN_STATE_DIR:?RUN_STATE_DIR required}
PARENT_SESSION_ID=${PARENT_SESSION_ID:?PARENT_SESSION_ID required}
SEEN_FILE="$RUN_STATE_DIR/seen_children"
DONE_DIR="$RUN_STATE_DIR/worker_done"
mkdir -p "$DONE_DIR"
printf '%s\n' "NATIVE-UI bridge pid=$$ parent=$PARENT_SESSION_ID" >> "$RUN_STATE_DIR/bridge.log"
printf '%s\n' "$$" > "$RUN_STATE_DIR/bridge.pid"

cleanup() { rm -f "$SEEN_FILE"; exit 0; }
trap cleanup EXIT INT TERM
until curl -s --max-time 2 "$SERVER_URL/" >/dev/null 2>&1; do sleep 1; done

curl -s --max-time 5 "$SERVER_URL/session" | jq -r --arg p "$PARENT_SESSION_ID" '.[] | select(.parentID == $p) | .id' > "$SEEN_FILE" 2>/dev/null || :
while true; do
  sessions=$(curl -s --max-time 5 "$SERVER_URL/session" 2>/dev/null || printf '[]')
  printf '%s\n' "$sessions" | jq -r --arg p "$PARENT_SESSION_ID" '.[] | select(.parentID == $p) | "\(.id)\t\(.agent // "unknown")"' 2>/dev/null |
    while IFS=$'\t' read -r id agent; do
      [ -n "$id" ] || continue
      if ! grep -qxF "$id" "$SEEN_FILE" 2>/dev/null; then
        printf '%s\n' "$id" >> "$SEEN_FILE"
        printf '%s\n' "native-UI-policy child=$id agent=$agent; no tmux pane" >> "$RUN_STATE_DIR/bridge.log"
      fi
      if [ -f "$DONE_DIR/$id" ]; then rm -f "$DONE_DIR/$id"; fi
  done
  sleep 2
done
