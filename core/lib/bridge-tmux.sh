#!/bin/bash
# lib/bridge-tmux.sh — Generic tmux bridge strategy
# Core consumes worker_done/<CHILD_ID>. Does not produce them.
# Core consumes worker_done/<CHILD_ID>. Does not produce them.

set -uo pipefail

SERVER_URL="${OPENCODE_SERVER_URL:?OPENCODE_SERVER_URL must be set}"
RUN_STATE_DIR="${RUN_STATE_DIR:?RUN_STATE_DIR must be set}"
PARENT_SESSION_ID="${PARENT_SESSION_ID:?PARENT_SESSION_ID must be set}"

ATTACHED_FILE="$RUN_STATE_DIR/attached_sessions"
PANES_FILE="$RUN_STATE_DIR/pane_titles"
DONE_DIR="$RUN_STATE_DIR/worker_done"
SEEN_FILE="$RUN_STATE_DIR/seen_children"
HOLD_DIR="$RUN_STATE_DIR/attach_holds"
NO_ATTACH_DIR="$RUN_STATE_DIR/no_attach"
POLL_INTERVAL=3

log() { echo "[$(date '+%H:%M:%S')] [bridge] $*" >&2; }

native_ui_only_agent() {
  local candidate="$1"
  local configured
  [ -n "${NATIVE_UI_ONLY_AGENTS:-}" ] || return 1
  IFS=',' read -ra configured_agents <<< "$NATIVE_UI_ONLY_AGENTS"
  for configured in "${configured_agents[@]}"; do
    configured=$(echo "$configured" | tr -d '[:space:]')
    [ "$candidate" = "$configured" ] && return 0
  done
  return 1
}

cleanup() {
  log "Bridge shutting down"
  rm -f "$ATTACHED_FILE" "$PANES_FILE" "$SEEN_FILE"
  rm -rf "$DONE_DIR"
  log "Bridge cleanup done"
  exit 0
}
trap cleanup EXIT INT TERM

mkdir -p "$DONE_DIR"
echo $$ > "$RUN_STATE_DIR/bridge.pid"

log "Waiting for server..."
READY=0
for i in $(seq 1 30); do
  curl -s --max-time 2 "$SERVER_URL/" >/dev/null 2>&1 && { READY=1; break; }
  sleep 1
done
[ "$READY" -eq 0 ] && { log "ERROR: Server not ready"; exit 1; }
log "Server ready"

TMUX_SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null || echo "")
[ -z "$TMUX_SESSION" ] && { log "ERROR: Not inside tmux"; exit 1; }

> "$ATTACHED_FILE"
> "$PANES_FILE"

seed_children=$(curl -s --max-time 5 "$SERVER_URL/session" 2>/dev/null | jq -r --arg pid "$PARENT_SESSION_ID" '.[] | select(.parentID == $pid) | .id' 2>/dev/null || echo "")
echo "$seed_children" > "$SEEN_FILE"
log "Seeded seen_children: $(echo "$seed_children" | grep -c . || echo 0) historical children"

log "Polling every ${POLL_INTERVAL}s ..."

while true; do
  # Phase 1: Reap children with worker_done markers
  if [ -f "$PANES_FILE" ]; then
    while IFS=: read -r pane_id agent sess_id; do
      [ -z "$pane_id" ] && continue
      [ -z "$sess_id" ] && continue
      if [ -f "$DONE_DIR/$sess_id" ]; then
        log "Reaping $agent pane $pane_id (worker_done marker found)"
        tmux kill-pane -t "$pane_id" 2>/dev/null || true
        sed -i '' "/^${pane_id}:/d" "$PANES_FILE" 2>/dev/null || true
        sed -i '' "/^${sess_id}$/d" "$ATTACHED_FILE" 2>/dev/null || true
        rm -f "$DONE_DIR/$sess_id"
      fi
    done < "$PANES_FILE"
  fi

  # Phase 2: Detect new children
  SESSIONS=$(curl -s --max-time 5 "$SERVER_URL/session" 2>/dev/null || echo "[]")
  echo "$SESSIONS" | jq -r --arg pid "$PARENT_SESSION_ID" '.[] | select(.parentID == $pid) | "\(.id)\t\(.agent // "unknown")\t\(.title // "")"' 2>/dev/null | while IFS=$'\t' read -r sess_id agent title; do
    [ -z "$sess_id" ] && continue

    if [ -d "$HOLD_DIR" ] && compgen -G "$HOLD_DIR/*.hold" >/dev/null 2>&1; then
      log "attach_holds active, deferring child $sess_id"
      continue
    fi

    if [ -f "$NO_ATTACH_DIR/${sess_id}.marker" ]; then
      grep -q "^${sess_id}$" "$SEEN_FILE" 2>/dev/null || echo "$sess_id" >> "$SEEN_FILE"
      rm -f "$NO_ATTACH_DIR/${sess_id}.marker"
      log "Child $sess_id native-UI-only, skipping pane"
      continue
    fi

    grep -q "^${sess_id}$" "$SEEN_FILE" 2>/dev/null && {
      if [ -f "$DONE_DIR/${sess_id}" ] && ! grep -q "^${sess_id}$" "$ATTACHED_FILE" 2>/dev/null; then
        rm -f "$DONE_DIR/${sess_id}"
        log "Child $sess_id already seen, unattached, worker_done consumed"
      fi
      continue
    }

    AGENT_LABEL="unknown"
    case "$agent" in
      explore) AGENT_LABEL="Explore" ;;
      librarian) AGENT_LABEL="Librarian" ;;
    esac
    if [ "$AGENT_LABEL" = "unknown" ]; then
      TITLE_LOWER=$(echo "$title" | tr '[:upper:]' '[:lower:]')
      echo "$TITLE_LOWER" | grep -qE "explore|search|codebase" && AGENT_LABEL="Explore"
      echo "$TITLE_LOWER" | grep -qE "librarian|research|doc" && AGENT_LABEL="Librarian"
    fi
    [ "$AGENT_LABEL" = "unknown" ] && continue

    if native_ui_only_agent "$agent"; then
      grep -q "^${sess_id}$" "$SEEN_FILE" 2>/dev/null || echo "$sess_id" >> "$SEEN_FILE"
      rm -f "$NO_ATTACH_DIR/${sess_id}.marker" 2>/dev/null
      log "Child $sess_id native-UI-policy, skipping pane"
      continue
    fi

    # Stop-before-discovery: check if already completed
    if [ -f "$DONE_DIR/$sess_id" ]; then
      log "Child $AGENT_LABEL $sess_id already completed (stop-before-discovery), consuming marker"
      echo "$sess_id" >> "$SEEN_FILE"
      rm -f "$DONE_DIR/$sess_id"
      continue
    fi

    log "New child: $AGENT_LABEL / $sess_id"

    SHORT_TITLE=$(echo "$title" | head -c 40)
    PANE_ID=$(tmux split-window -h -d -P -F "#{pane_id}" \
      -t "$TMUX_SESSION" \
      "\"$OPENCODE_BIN\" attach '$SERVER_URL' --session '$sess_id'; echo ''; echo '[$AGENT_LABEL] Done'; sleep 3" 2>/dev/null || echo "")

    if [ -n "$PANE_ID" ]; then
      echo "$sess_id" >> "$SEEN_FILE"
      tmux select-pane -t "$PANE_ID" -T "$AGENT_LABEL | $SHORT_TITLE" 2>/dev/null || true
      echo "$PANE_ID:$AGENT_LABEL:$sess_id" >> "$PANES_FILE"
      echo "$sess_id" >> "$ATTACHED_FILE"
      log "Pane $PANE_ID created for $AGENT_LABEL"
    else
      log "Pane creation failed for $AGENT_LABEL $sess_id, will retry next cycle"
    fi
  done

  sleep "$POLL_INTERVAL"
done
