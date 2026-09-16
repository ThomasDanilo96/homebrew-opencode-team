#!/bin/bash
# lib/core.sh — Shared team runtime lifecycle
# Shared lifecycle with generic bridge selection. No team-name branching.
# Uses BASH_SOURCE[0] for own directory resolution.

set -uo pipefail

_CORE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- State paths (set after config parse) ---
RUN_STATE_DIR=""
LOCK_ROOT=""
CLAIM_SESSION_ID=""
SESSION_DIRECTORY=""
PARENT_SESSION_ID=""
SERVER_PID=""
BRIDGE_PID=""
WATCHDOG_PID=""
LAUNCHER_PID=""
CLEANED=0

log() { echo "[$(date '+%H:%M:%S')] [core] $*" >&2; }
die() { echo "ERROR: $*" >&2; exit 1; }

process_start_epoch() {
  local pid="$1" raw
  raw=$(LC_ALL=C ps -p "$pid" -o lstart= 2>/dev/null) || return 1
  [ -n "$raw" ] || return 1
  printf '%s\n' "$raw" | python3 -c 'import sys,time; print(int(time.mktime(time.strptime(sys.stdin.read().strip(), "%a %b %d %H:%M:%S %Y"))))' 2>/dev/null
}

write_process_identity() {
  local role="$1" pid="$2" start pgid sid tmp
  case "$role" in launcher|server|bridge|watchdog|attach) ;; *) return 1 ;; esac
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  start=$(process_start_epoch "$pid") || return 1
  pgid=$(ps -p "$pid" -o pgid= 2>/dev/null | tr -d ' ') || return 1
  sid=$(ps -p "$pid" -o sess= 2>/dev/null | tr -d ' ') || return 1
  [ -n "$pgid" ] && [ -n "$sid" ] || return 1
  tmp="$RUN_STATE_DIR/.${role}.identity.$$.$RANDOM"
  printf 'pid=%s\nstart_epoch=%s\npgid=%s\nsid=%s\nrole=%s\nrun_id=%s\n' \
    "$pid" "$start" "$pgid" "$sid" "$role" "$RUN_ID" > "$tmp" || return 1
  mv -f "$tmp" "$RUN_STATE_DIR/$role.identity"
}

process_owned_by_run() {
  local role="$1" pid="$2" identity stored_pid stored_start stored_pgid stored_sid stored_role stored_run
  identity="$RUN_STATE_DIR/$role.identity"
  [ -f "$identity" ] || return 1
  stored_pid=$(sed -n 's/^pid=//p' "$identity" 2>/dev/null)
  stored_start=$(sed -n 's/^start_epoch=//p' "$identity" 2>/dev/null)
  stored_pgid=$(sed -n 's/^pgid=//p' "$identity" 2>/dev/null)
  stored_sid=$(sed -n 's/^sid=//p' "$identity" 2>/dev/null)
  stored_role=$(sed -n 's/^role=//p' "$identity" 2>/dev/null)
  stored_run=$(sed -n 's/^run_id=//p' "$identity" 2>/dev/null)
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  case "$stored_pid:$stored_start:$stored_pgid:$stored_sid:$stored_role:$stored_run" in
    *[!0-9A-Za-z_:-]*|*::*|*:) return 1 ;;
  esac
  [ "$pid" = "$stored_pid" ] || return 1
  [ "$stored_role" = "$role" ] || return 1
  [ "$stored_run" = "$RUN_ID" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [ "$(process_start_epoch "$pid")" = "$stored_start" ] || return 1
  [ "$(ps -p "$pid" -o pgid= 2>/dev/null | tr -d ' ')" = "$stored_pgid" ] || return 1
  [ "$(ps -p "$pid" -o sess= 2>/dev/null | tr -d ' ')" = "$stored_sid" ] || return 1
}

safe_signal() {
  local role="$1" pid="$2" signal="$3"
  if [ ! -f "$RUN_STATE_DIR/$role.identity" ]; then
    log "SKIP_SIGNAL role=$role pid=$pid reason=missing_identity"
    return 1
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    log "SKIP_SIGNAL role=$role pid=$pid reason=not_alive"
    return 1
  fi
  if ! process_owned_by_run "$role" "$pid"; then
    log "SKIP_SIGNAL role=$role pid=$pid reason=identity_mismatch"
    return 1
  fi
  kill -"$signal" "$pid" 2>/dev/null
}

wait_for_owned_exit() {
  local role="$1" pid="$2" ticks="$3" i=0
  while [ "$i" -lt "$ticks" ]; do
    process_owned_by_run "$role" "$pid" || return 0
    sleep 0.2
    i=$((i + 1))
  done
  return 1
}

# RUN_ID handling:
# - If TEAM_RUNTIME_INNER=1: require valid RUN_ID, preserve it, never regenerate
# - If TEAM_RUNTIME_INNER unset: generate fresh RUN_ID (public invocation)
# This prevents ambient RUN_ID from parent sessions being reused.
ensure_run_id() {
  if [ "${TEAM_RUNTIME_INNER:-}" = "1" ]; then
    # Inner reentry: RUN_ID must be supplied and valid
    case "${RUN_ID:-}" in
      [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
      *)
        die "Inner reentry: missing or invalid RUN_ID"
        ;;
    esac
  else
    # Public invocation: always generate fresh RUN_ID, ignore ambient
    RUN_ID=$(python3 -c "import secrets; print(secrets.token_hex(4))")
  fi
}

init_run_state() {
  RUN_STATE_DIR="$SANDBOX/state/runs/$RUN_ID"
  LOCK_ROOT="$SANDBOX/state/session-locks"
  local expected_prefix="$SANDBOX/state/runs/"
  case "$RUN_STATE_DIR" in
    "$expected_prefix"*) ;;
    *) die "RUN_STATE_DIR not under expected prefix" ;;
  esac
  mkdir -p "$RUN_STATE_DIR"
}

# --- Cleanup (certified GO order) ---
cleanup_run() {
  [ "$CLEANED" -eq 1 ] && return
  CLEANED=1

  local _bridge_pid="${BRIDGE_PID:-}"
  local _server_pid="${SERVER_PID:-}"
  local _watchdog_pid=""
  if [ -f "$RUN_STATE_DIR/watchdog.pid" ]; then
    _watchdog_pid=$(cat "$RUN_STATE_DIR/watchdog.pid" 2>/dev/null)
  fi
  if [ -z "$_bridge_pid" ] && [ -f "$RUN_STATE_DIR/bridge.pid" ]; then
    _bridge_pid=$(cat "$RUN_STATE_DIR/bridge.pid" 2>/dev/null)
  fi
  if [ -z "$_server_pid" ] && [ -f "$RUN_STATE_DIR/server.pid" ]; then
    _server_pid=$(cat "$RUN_STATE_DIR/server.pid" 2>/dev/null)
  fi

  # Phase 1: bridge
  if [ -n "$_bridge_pid" ] && safe_signal bridge "$_bridge_pid" TERM; then
    if ! wait_for_owned_exit bridge "$_bridge_pid" 10; then
      safe_signal bridge "$_bridge_pid" KILL || true
    fi
  fi

  # Phase 2: watchdog
  if [ -n "$_watchdog_pid" ]; then
    safe_signal watchdog "$_watchdog_pid" TERM || true
  fi

  # Phase 3: panes
  if [ -f "$RUN_STATE_DIR/pane_titles" ]; then
    while IFS=: read -r pane_id _ _; do
      [ -z "$pane_id" ] && continue
      tmux kill-pane -t "$pane_id" 2>/dev/null || true
    done < "$RUN_STATE_DIR/pane_titles"
  fi

  # Phase 4: server
  if [ -n "$_server_pid" ] && safe_signal server "$_server_pid" TERM; then
    if ! wait_for_owned_exit server "$_server_pid" 25; then
      safe_signal server "$_server_pid" KILL || true
    fi
  fi

  # Phase 5: claim release
  if [ -n "$CLAIM_SESSION_ID" ] && [ -d "$LOCK_ROOT/$CLAIM_SESSION_ID" ]; then
    local OWNED_BY
    OWNED_BY=$(cat "$LOCK_ROOT/$CLAIM_SESSION_ID/run_id" 2>/dev/null)
    if [ "$OWNED_BY" = "$RUN_ID" ]; then
      rm -rf "$LOCK_ROOT/$CLAIM_SESSION_ID"
    fi
  fi

  # Phase 6: remove run-state
  [ -d "$RUN_STATE_DIR" ] && rm -rf "$RUN_STATE_DIR"
}

# --- Pre-server hook (exit-status based, no string inspection) ---
run_pre_server_hook() {
  local hook_path="$1"
  local hook_output hook_rc
  hook_output=$("$hook_path" 2>&1)
  hook_rc=$?
  log "$hook_output"
  if [ "$hook_rc" -ne 0 ]; then
    die "Pre-server hook failed (exit $hook_rc)"
  fi
}

bridge_private_auth_file() {
  local source_path="$1" destination_path="$2" disposable_root="$3" label="$4"
  python3 - "$source_path" "$destination_path" "$disposable_root" "$label" <<'PY'
import os
import shutil
import stat
import sys
import tempfile
from pathlib import Path

source, destination, root, label = sys.argv[1:]
uid = os.getuid()

def fail(message):
    print(f"{label} auth bridge refused: {message}", file=sys.stderr)
    sys.exit(1)

def validate(path, name):
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        fail(f"{name} missing")
    if stat.S_ISLNK(info.st_mode):
        fail(f"{name} is symlink")
    if not stat.S_ISREG(info.st_mode):
        fail(f"{name} is not regular")
    if info.st_uid != uid:
        fail(f"{name} owner mismatch")
    if info.st_nlink != 1:
        fail(f"{name} link count mismatch")
    if stat.S_IMODE(info.st_mode) != 0o600:
        fail(f"{name} mode is not 0600")
    return info

root_real = os.path.realpath(root)
dest = Path(destination)
parent = dest.parent
parent.mkdir(parents=True, exist_ok=True)
parent_real = os.path.realpath(parent)
if not (parent_real == root_real or parent_real.startswith(root_real + os.sep)):
    fail("destination outside disposable root")

src_before = validate(source, "source")
flags = os.O_RDONLY
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW
try:
    source_fd = os.open(source, flags)
except OSError as error:
    fail(f"source open failed: {error.strerror}")
try:
    src_after = os.fstat(source_fd)
    if (src_before.st_dev, src_before.st_ino) != (src_after.st_dev, src_after.st_ino):
        fail("source changed during validation")
    fd, tmp = tempfile.mkstemp(prefix=".auth.", dir=parent_real)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(source_fd, "rb", closefd=False) as src, os.fdopen(fd, "wb", closefd=False) as out:
            shutil.copyfileobj(src, out)
            out.flush()
            os.fsync(out.fileno())
        os.close(fd)
        fd = -1
        validate(tmp, "temporary destination")
        os.replace(tmp, destination)
        validate(destination, "destination")
    finally:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            os.unlink(tmp)
        except OSError:
            pass
finally:
    try:
        os.close(source_fd)
    except OSError:
        pass
PY
}

bridge_opencode_auth() {
  local source_path="${OPENCODE_AUTH_SOURCE:-${OPENCODE_TEAM_OPENCODE_AUTH_SOURCE:-}}"
  [ -n "$source_path" ] || return 0
  local destination="$XDG_DATA_HOME/opencode/auth.json"
  bridge_private_auth_file "$source_path" "$destination" "$SANDBOX" "OpenCode"
  log "OpenCode auth bridge installed"
}

# --- Claims (atomic mkdir, dead-owner fallback) ---
claim_session() {
  local SID="$1"
  mkdir -p "$LOCK_ROOT" 2>/dev/null
  if mkdir "$LOCK_ROOT/$SID" 2>/dev/null; then
    echo "$RUN_ID" > "$LOCK_ROOT/$SID/run_id"
    echo "$$" > "$LOCK_ROOT/$SID/pid"
    CLAIM_SESSION_ID="$SID"
    echo "$SID" > "$RUN_STATE_DIR/resume_claim"
    return 0
  fi
  local OWNER_RUN OWNER_TMUX
  OWNER_RUN=$(cat "$LOCK_ROOT/$SID/run_id" 2>/dev/null)
  OWNER_TMUX="${TMUX_PREFIX}-${OWNER_RUN:-unknown}"
  if tmux has-session -t "$OWNER_TMUX" 2>/dev/null; then
    return 1
  fi
  rm -rf "$LOCK_ROOT/$SID"
  if mkdir "$LOCK_ROOT/$SID" 2>/dev/null; then
    echo "$RUN_ID" > "$LOCK_ROOT/$SID/run_id"
    echo "$$" > "$LOCK_ROOT/$SID/pid"
    CLAIM_SESSION_ID="$SID"
    echo "$SID" > "$RUN_STATE_DIR/resume_claim"
    return 0
  fi
  return 1
}

# --- Port allocation ---
allocate_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}

# --- Resume directory resolution ---
resolve_resume_dir() {
  local session_id="$1"
  local exppath
  exppath=$(mktemp)
  HOME="$SANDBOX" \
    XDG_CONFIG_HOME="$SANDBOX/config" \
    XDG_DATA_HOME="$SANDBOX/data" \
    XDG_CACHE_HOME="$SANDBOX/cache" \
    XDG_STATE_HOME="$SANDBOX/state" \
    OPENCODE_CONFIG="$OPENCODE_CONFIG" \
    OPENCODE_CONFIG_DIR="$(dirname "$OPENCODE_CONFIG")" \
    OPENCODE_DISABLE_PROJECT_CONFIG=1 \
    OPENCODE_DISABLE_CLAUDE_CODE=1 \
    CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR_OVERRIDE:-}" \
    OMO_PROFILE="$OMO_PROFILE" \
    opencode export "$session_id" > "$exppath" 2>/dev/null

  SESSION_DIRECTORY=$(python3 -c "
import json, sys
try:
    with open('$exppath') as f:
        data = json.load(f)
    info = data.get('info', {})
    d = info.get('directory', '')
    print(d)
except: pass
" 2>/dev/null)
  rm -f "$exppath"

  if [ -n "$SESSION_DIRECTORY" ] && [ ! -d "$SESSION_DIRECTORY" ]; then
    log "ERROR: Historical directory $SESSION_DIRECTORY does not exist."
    return 1
  fi
  echo "$SESSION_DIRECTORY" > "$RUN_STATE_DIR/session_directory"
  return 0
}

# --- Server ---
start_server() {
  cd "$SESSION_DIRECTORY" || die "Cannot cd to $SESSION_DIRECTORY"
  opencode serve --port "$PORT" --hostname 127.0.0.1 &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$RUN_STATE_DIR/server.pid"
  write_process_identity server "$SERVER_PID" || die "Failed to record server identity"
  log "Server PID: $SERVER_PID"
}

wait_server() {
  local ready=0
  for i in $(seq 1 30); do
    curl -skL --max-time 2 "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && { ready=1; break; }
    sleep 1
  done
  [ "$ready" -eq 0 ] && die "Server not ready after 30s"
  log "Server ready"
}

# --- Session management ---
create_parent_session() {
  PARENT_SESSION_ID=$(curl -s -X POST "http://127.0.0.1:$PORT/session" \
    -H "Content-Type: application/json" -d '{}' | jq -r '.id // empty')
  [ -z "$PARENT_SESSION_ID" ] && die "Failed to create parent session"
  echo "$PARENT_SESSION_ID" > "$RUN_STATE_DIR/parent_session_id"
  log "Parent session: $PARENT_SESSION_ID"
}

# Only assistant messages owned by the resumed root session establish
# provenance. Child/subagent messages are ignored even if returned by an API
# export alongside the root-session messages.
root_session_agents() {
  local session_id="$1" message_data="$2"
  printf '%s\n' "$message_data" | jq -er --arg session_id "$session_id" '
    def message_payload:
      if type == "array" then .
      elif type == "object" and (.data | type == "array") then .data
      else [] end;
    message_payload as $messages
    | [
        $messages[]?
        | .info? as $info
        | select(
            ($info | type) == "object"
            and $info.sessionID == $session_id
            and $info.role == "assistant"
            and ($info.agent | type) == "string"
            and ($info.agent | length) > 0
            # OpenCode emits synthetic assistant records during compaction;
            # they do not establish root-session provenance.
            and $info.agent != "compaction"
          )
        | $info.agent
      ]
    | unique
    | join("\n")
  ' 2>/dev/null
}

resume_agent_allowed() {
  local candidate="$1" allowed
  local -a allowed_agents=()
  IFS=',' read -ra allowed_agents <<< "$RESUME_ALLOWED_AGENTS"
  for allowed in "${allowed_agents[@]}"; do
    [ "$candidate" = "$allowed" ] && return 0
  done
  return 1
}

validate_root_session_provenance() {
  local session_id="$1" message_data="$2" agents agent
  agents=$(root_session_agents "$session_id" "$message_data") || return 1
  [ -n "$agents" ] || return 1
  while IFS= read -r agent; do
    [ -n "$agent" ] || continue
    resume_agent_allowed "$agent" || return 1
  done <<< "$agents"
  return 0
}

validate_resume_session() {
  local session_id="$1"
  local session_data
  session_data=$(curl -skL --max-time 5 "http://127.0.0.1:$PORT/session/$session_id" 2>/dev/null)
  local retrieved_id
  retrieved_id=$(echo "$session_data" | jq -r '.id // empty' 2>/dev/null)
  [ "$retrieved_id" != "$session_id" ] && die "Session $session_id not found"
  local parent_check
  parent_check=$(echo "$session_data" | jq -r '.parentID // "ROOT"' 2>/dev/null)
  [ "$parent_check" != "ROOT" ] && die "Cannot resume a child/subagent session"
  local message_data
  message_data=$(curl -skL --max-time 5 "http://127.0.0.1:$PORT/session/$session_id/message" 2>/dev/null || true)
  if ! validate_root_session_provenance "$session_id" "$message_data"; then
    die "Session $session_id does not belong to team $TEAM_NAME"
  fi
  PARENT_SESSION_ID="$session_id"
  echo "$PARENT_SESSION_ID" > "$RUN_STATE_DIR/parent_session_id"
  local session_title
  session_title=$(echo "$session_data" | jq -r '.title // ""' 2>/dev/null)
  [ -n "$session_title" ] && echo "$session_title" > "$RUN_STATE_DIR/session_title"
  log "Resuming: $PARENT_SESSION_ID"
}

# --- Watchdog ---
start_watchdog() {
  local my_tmux="$1"
  (
    trap '' HUP
    while [ -n "$my_tmux" ]; do
      sleep 2
      tmux has-session -t "$my_tmux" 2>/dev/null || {
        log "Watchdog: tmux session gone — killing run processes"
        local p
        p=$(cat "$RUN_STATE_DIR/server.pid" 2>/dev/null)
        [ -n "$p" ] && safe_signal server "$p" TERM || true
        p=$(cat "$RUN_STATE_DIR/bridge.pid" 2>/dev/null)
        [ -n "$p" ] && safe_signal bridge "$p" TERM || true
        local _apid=$(cat "$RUN_STATE_DIR/attach.pid" 2>/dev/null)
        [ -n "$_apid" ] && safe_signal attach "$_apid" TERM || true
        safe_signal launcher "$LAUNCHER_PID" TERM || true
        exit 0
      }
    done
  ) &
  WATCHDOG_PID=$!
  echo "$WATCHDOG_PID" > "$RUN_STATE_DIR/watchdog.pid"
  write_process_identity watchdog "$WATCHDOG_PID" || die "Failed to record watchdog identity"
  log "Watchdog PID: $WATCHDOG_PID"
}

# --- Bridge strategy (selected only by BRIDGE_MODE) ---
start_bridge() {
  local bridge_file
  case "$BRIDGE_MODE" in
    tmux) bridge_file="$_CORE_DIR/bridge-tmux.sh" ;;
    native_ui) bridge_file="$_CORE_DIR/bridge-native-ui.sh" ;;
    *) die "Invalid BRIDGE_MODE: $BRIDGE_MODE" ;;
  esac
  RUN_ID="$RUN_ID" \
    RUN_STATE_DIR="$RUN_STATE_DIR" \
    OPENCODE_SERVER_URL="http://127.0.0.1:$PORT" \
    PARENT_SESSION_ID="$PARENT_SESSION_ID" \
    BRIDGE_MODE="$BRIDGE_MODE" \
    bash "$bridge_file" >> "$RUN_STATE_DIR/bridge.log" 2>&1 &
  BRIDGE_PID=$!
  echo "$BRIDGE_PID" > "$RUN_STATE_DIR/bridge.pid"
  write_process_identity bridge "$BRIDGE_PID" || die "Failed to record bridge identity"
  log "Bridge PID: $BRIDGE_PID"
}

# --- Attach (foreground exec, certified GO behavior) ---
start_attach() {
  log "Attaching TUI to session $PARENT_SESSION_ID"
  bash -c '
    pid=$$
    raw=$(LC_ALL=C ps -p "$pid" -o lstart= 2>/dev/null)
    start=$(LC_ALL=C date -j -f "%a %b %d %T %Y" "$raw" "+%s" 2>/dev/null)
    pgid=$(ps -p "$pid" -o pgid= 2>/dev/null | tr -d " ")
    sid=$(ps -p "$pid" -o sess= 2>/dev/null | tr -d " ")
    tmp="$1/.attach.identity.$$.$RANDOM"
    printf "pid=%s\\nstart_epoch=%s\\npgid=%s\\nsid=%s\\nrole=attach\\nrun_id=%s\\n" "$pid" "$start" "$pgid" "$sid" "$4" > "$tmp" && mv -f "$tmp" "$1/attach.identity"
    printf "%s\\n" "$pid" > "$1/attach.pid"
    exec opencode attach "$2" --session "$3"
  ' bash "$RUN_STATE_DIR" "http://127.0.0.1:$PORT" "$PARENT_SESSION_ID" "$RUN_ID"
  local oc_exit=$?
  log "TUI exited (code=$oc_exit)"
}

# --- Export environment ---
export_env() {
  export OPENCODE_CONFIG="$OPENCODE_CONFIG"
  export OPENCODE_CONFIG_DIR="$(dirname "$OPENCODE_CONFIG")"
  export OPENCODE_DISABLE_PROJECT_CONFIG=1
  export OPENCODE_DISABLE_CLAUDE_CODE=1
  export OMO_PROFILE="$OMO_PROFILE"
  export OMO_SEND_ANONYMOUS_TELEMETRY=0
  export OMO_DISABLE_POSTHOG=1
  export OPENCODE_SERVER_URL="http://127.0.0.1:$PORT"
  export XDG_CONFIG_HOME="${XDG_CONFIG_HOME_OVERRIDE:-$SANDBOX/config}"
  export XDG_DATA_HOME="$SANDBOX/data"
  export XDG_CACHE_HOME="$SANDBOX/cache"
  export XDG_STATE_HOME="$SANDBOX/state"
  export BRIDGE_MODE="$BRIDGE_MODE"
  if [ -n "${CLAUDE_CONFIG_DIR_OVERRIDE:-}" ]; then
    export CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR_OVERRIDE"
  else
    unset CLAUDE_CONFIG_DIR
  fi
  export NATIVE_UI_ONLY_AGENTS="${NATIVE_UI_ONLY_AGENTS:-}"
}

source_runtime_env_hook() {
  if [ -n "${RUNTIME_ENV_HOOK:-}" ]; then
    log "Sourcing runtime environment hook..."
    # Source in this shell so exports reach PRE_SERVER_HOOK and opencode serve.
    source "$RUNTIME_ENV_HOOK" || die "Runtime environment hook failed"
  fi
}

# --- Main lifecycle ---
main() {
  local config_file="${1:-}"
  [ -z "$config_file" ] && die "--config required"

  # Parse config (config.sh already sourced by team-runtime)
  parse_team_config "$config_file" || exit 1

  # Init RUN_ID: respect TEAM_RUNTIME_INNER marker
  ensure_run_id
  init_run_state

  LAUNCHER_PID=$$
  echo "$LAUNCHER_PID" > "$RUN_STATE_DIR/launcher.pid"
  write_process_identity launcher "$LAUNCHER_PID" || die "Failed to record launcher identity"

  trap cleanup_run EXIT INT TERM HUP

  local session_mode="${SESSION_MODE:-new}"
  local resume_session_id="${RESUME_SESSION_ID:-}"

  # Port
  PORT=$(allocate_port)

  # Resume or new
  if [ "$session_mode" = "resume" ] && [ -n "$resume_session_id" ]; then
    claim_session "$resume_session_id" || die "Session $resume_session_id is already managed"
    resolve_resume_dir "$resume_session_id" || exit 1
    SESSION_DIRECTORY=$(cat "$RUN_STATE_DIR/session_directory" 2>/dev/null)
    log "Historical directory: ${SESSION_DIRECTORY:-~}"
  else
    SESSION_DIRECTORY="$PWD"
  fi

  # Write state files (NO premature server.pid)
  echo "$PORT" > "$RUN_STATE_DIR/port"
  echo "$RUN_ID" > "$RUN_STATE_DIR/run_id"
  echo "$(python3 -c 'import os,pwd; print(pwd.getpwuid(os.getuid()).pw_dir)')" > "$RUN_STATE_DIR/real_home"
  echo "$session_mode" > "$RUN_STATE_DIR/session_mode"

  # Export env
  export_env
  source_runtime_env_hook
  bridge_opencode_auth

  log "Run ID: $RUN_ID  Port: $PORT  Mode: $session_mode"

  # Pre-server hook (exit-status based, no string inspection)
  if [ -n "${PRE_SERVER_HOOK:-}" ]; then
    log "Running pre-server hook..."
    run_pre_server_hook "$PRE_SERVER_HOOK"
  fi

  # Start server
  log "Starting headless server..."
  start_server
  wait_server

  # Session management
  if [ "$session_mode" = "resume" ]; then
    validate_resume_session "$resume_session_id"
    log "Resuming: $PARENT_SESSION_ID"
    [ -f "$RUN_STATE_DIR/session_title" ] && log "Title: $(cat "$RUN_STATE_DIR/session_title")"
  else
    create_parent_session
    claim_session "$PARENT_SESSION_ID" || die "Failed to claim new session $PARENT_SESSION_ID"
  fi

  # Bridge
  start_bridge

  # Watchdog
  local my_tmux
  my_tmux=$(tmux display-message -p '#{session_name}' 2>/dev/null || echo "")
  if [ -n "$my_tmux" ]; then
    start_watchdog "$my_tmux"
  fi

  if [ "${TEAM_RUNTIME_HEADLESS:-}" = 1 ]; then
    while kill -0 "$SERVER_PID" 2>/dev/null; do sleep 1; done
  else
    start_attach
  fi
}
