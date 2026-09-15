#!/usr/bin/env bash
set -euo pipefail

TASK="${1:-}"
PACKAGE_ROOT="${PACKAGE_ROOT:?PACKAGE_ROOT is required}"
DATA_ROOT="${DATA_ROOT:?DATA_ROOT is required}"
STATE_ROOT="${STATE_ROOT:?STATE_ROOT is required}"

case "$TASK" in
  best-tool-output-gc|best-retention|openai-retention) ;;
  *) printf 'Unknown maintenance task: %s\n' "$TASK" >&2; exit 2 ;;
esac

mkdir -p "$STATE_ROOT/maintenance/locks" "$STATE_ROOT/maintenance/logs"
LOCK_DIR="$STATE_ROOT/maintenance/locks/$TASK.lock"
LOCK_GRACE_SECONDS="${OPENCODE_MAINTENANCE_LOCK_GRACE_SECONDS:-2}"
case "$LOCK_GRACE_SECONDS" in ''|*[!0-9]*) LOCK_GRACE_SECONDS=2 ;; esac
LOCK_TOKEN="${BASHPID:-$$}.$RANDOM.$RANDOM.$(date +%s)"
LOCK_START_IDENTITY=""
LOCK_HELD=0

maintenance_process_start_identity() {
  local pid="$1" raw
  raw="$(LC_ALL=C ps -p "$pid" -o lstart= 2>/dev/null)" || return 1
  [ -n "$raw" ] || return 1
  printf '%s\n' "$raw" | awk '{$1=$1; print}' | tr -s ' ' | tr ':' '_'
}

maintenance_rename() {
  perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$1" "$2" 2>/dev/null
}

maintenance_owner_read() {
  local file="$LOCK_DIR/owner"
  OWNER_PID="$(sed -n 's/^pid=//p' "$file" 2>/dev/null || true)"
  OWNER_START="$(sed -n 's/^process_start_identity=//p' "$file" 2>/dev/null || true)"
  OWNER_TOKEN="$(sed -n 's/^token=//p' "$file" 2>/dev/null || true)"
  OWNER_CREATED="$(sed -n 's/^created_epoch=//p' "$file" 2>/dev/null || true)"
  case "$OWNER_PID" in ''|*[!0-9]*) return 1 ;; esac
  [ -n "$OWNER_START" ] && [ -n "$OWNER_TOKEN" ] || return 1
  case "$OWNER_CREATED" in ''|*[!0-9]*) return 1 ;; esac
}

maintenance_lock_age() {
  local modified now
  modified="$(stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR" 2>/dev/null || printf '0')"
  now="$(date +%s)"
  case "$modified:$now" in *[!0-9:]*) printf '%s\n' 0 ;; *)
    if [ "$now" -ge "$modified" ]; then printf '%s\n' "$((now - modified))"; else printf '%s\n' 0; fi
  esac
}

maintenance_owner_active() {
  local current_start
  kill -0 "$OWNER_PID" 2>/dev/null || return 1
  current_start="$(maintenance_process_start_identity "$OWNER_PID" || true)"
  [ -n "$current_start" ] && [ "$current_start" = "$OWNER_START" ]
}

maintenance_publish_owner() {
  local stage="$LOCK_DIR/.owner.$LOCK_TOKEN"
  mkdir "$LOCK_DIR" 2>/dev/null || return 1
  printf 'pid=%s\nprocess_start_identity=%s\ntoken=%s\ncreated_epoch=%s\n' \
    "$$" "$LOCK_START_IDENTITY" "$LOCK_TOKEN" "$(date +%s)" > "$stage" || {
      rm -f "$stage"
      return 1
    }
  if maintenance_rename "$stage" "$LOCK_DIR/owner"; then
    LOCK_HELD=1
    return 0
  fi
  rm -f "$stage"
  return 1
}

maintenance_restore_fenced() {
  local fenced="$1"
  [ -e "$LOCK_DIR" ] || maintenance_rename "$fenced" "$LOCK_DIR" || true
}

maintenance_reclaim_and_publish() {
  local fenced="$LOCK_DIR.stale.$LOCK_TOKEN"
  if ! maintenance_rename "$LOCK_DIR" "$fenced"; then
    return 1
  fi
  if maintenance_publish_owner; then
    rm -rf "$fenced"
    return 0
  fi
  maintenance_restore_fenced "$fenced"
  rm -rf "$fenced" 2>/dev/null || true
  return 1
}

maintenance_acquire_lock() {
  LOCK_START_IDENTITY="$(maintenance_process_start_identity "$$" || true)"
  [ -n "$LOCK_START_IDENTITY" ] || { printf 'Unable to identify maintenance process\n' >&2; exit 1; }
  if maintenance_publish_owner; then
    return 0
  fi

  if maintenance_owner_read; then
    if maintenance_owner_active; then
      printf 'SKIP_ALREADY_RUNNING task=%s\n' "$TASK"
      exit 0
    fi
  elif [ "$(maintenance_lock_age)" -lt "$LOCK_GRACE_SECONDS" ]; then
    printf 'SKIP_LOCK_UNCERTAIN task=%s\n' "$TASK"
    exit 0
  fi

  if maintenance_reclaim_and_publish; then
    return 0
  fi
  if maintenance_owner_read && maintenance_owner_active; then
    printf 'SKIP_ALREADY_RUNNING task=%s\n' "$TASK"
    exit 0
  fi
  printf 'SKIP_LOCK_UNCERTAIN task=%s\n' "$TASK"
  exit 0
}

cleanup_lock() {
  [ "$LOCK_HELD" = 1 ] || return 0
  maintenance_owner_read || return 0
  [ "$OWNER_PID" = "$$" ] || return 0
  [ "$OWNER_START" = "$LOCK_START_IDENTITY" ] || return 0
  [ "$OWNER_TOKEN" = "$LOCK_TOKEN" ] || return 0
  local expected_owner fenced
  expected_owner="$(cat "$LOCK_DIR/owner" 2>/dev/null || true)"
  if [ -n "${OPENCODE_MAINTENANCE_TEST_CLEANUP_DELAY_MS:-}" ]; then
    sleep "$(python3 -c 'import os; print(float(os.environ["OPENCODE_MAINTENANCE_TEST_CLEANUP_DELAY_MS"]) / 1000)')"
  fi
  fenced="$LOCK_DIR.release.$LOCK_TOKEN"
  maintenance_rename "$LOCK_DIR" "$fenced" || return 0
  if [ "$(cat "$fenced/owner" 2>/dev/null || true)" = "$expected_owner" ]; then
    rm -rf "$fenced"
  elif [ ! -e "$LOCK_DIR" ]; then
    maintenance_rename "$fenced" "$LOCK_DIR" || true
  fi
}

maintenance_acquire_lock
trap cleanup_lock EXIT INT TERM HUP
if [ -n "${OPENCODE_MAINTENANCE_TEST_DELAY_MS:-}" ]; then
  sleep "$(python3 -c 'import os; print(float(os.environ["OPENCODE_MAINTENANCE_TEST_DELAY_MS"]) / 1000)')"
fi

case "$TASK" in
  best-tool-output-gc)
    if [ ! -d "$DATA_ROOT/best/data/opencode/tool-output" ] || [ ! -f "$DATA_ROOT/best/data/opencode/opencode.db" ]; then
      printf 'SKIP_NO_BEST_TOOL_OUTPUT_STORE\n'
      exit 0
    fi
    BEST_TOOL_OUTPUT_DIR="$DATA_ROOT/best/data/opencode/tool-output" \
      BEST_OPENCODE_DB="$DATA_ROOT/best/data/opencode/opencode.db" \
      node "$PACKAGE_ROOT/teams/best/tool-output-gc.mjs" --tool-output-gc
    ;;
  best-retention)
    OPENCODE_MAINTENANCE_BASE="$DATA_ROOT/opencode" \
      OPENCODE_MAINTENANCE_SANDBOXES="$DATA_ROOT" \
      OPENCODE_MAINTENANCE_LOG_FILE="$STATE_ROOT/maintenance/logs/best-retention.log" \
      python3 "$PACKAGE_ROOT/shared/maintenance/opencode-cleanup.py" \
        --retention-only --live-retention --team best --max-families 1 --max-session-deletes 3
    ;;
  openai-retention)
    OPENCODE_RETENTION_DAYS=7 \
      OPENAI_TEAM_STATE_ROOT="$DATA_ROOT/openai/state/team" \
      OPENAI_WORK_PACKET_RETENTION_DAYS="${OPENAI_WORK_PACKET_RETENTION_DAYS:-7}" \
      OPENCODE_MAINTENANCE_BASE="$DATA_ROOT/opencode" \
      OPENCODE_MAINTENANCE_SANDBOXES="$DATA_ROOT" \
      OPENCODE_MAINTENANCE_LOG_FILE="$STATE_ROOT/maintenance/logs/openai-retention.log" \
      python3 "$PACKAGE_ROOT/shared/maintenance/opencode-cleanup.py" \
        --retention-only --live-retention --team openai --max-families 3 --max-session-deletes 10
    OPENAI_TEAM_STATE_ROOT="$DATA_ROOT/openai/state/team" \
      OPENAI_WORK_PACKET_RETENTION_DAYS="${OPENAI_WORK_PACKET_RETENTION_DAYS:-7}" \
      node "$PACKAGE_ROOT/shared/maintenance/openai-state-retention.mjs"
    ;;
esac
