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
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  if [ -f "$LOCK_DIR/pid" ] && kill -0 "$(< "$LOCK_DIR/pid")" 2>/dev/null; then
    printf 'SKIP_ALREADY_RUNNING task=%s\n' "$TASK"
    exit 0
  fi
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR"
fi
printf '%s\n' "$$" > "$LOCK_DIR/pid"
cleanup_lock() { rm -rf "$LOCK_DIR"; }
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
