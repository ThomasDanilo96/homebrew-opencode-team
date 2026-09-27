#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="$(mktemp -d "${TMPDIR:-/tmp}/best-recycle-test.XXXXXX")"
cleanup() {
  kill "${OLD_PID:-}" "${NEW_PID:-}" 2>/dev/null || true
  wait "${OLD_PID:-}" "${NEW_PID:-}" 2>/dev/null || true
  rm -rf "$STATE"
}
trap cleanup EXIT

source "$ROOT/core/lib/core.sh"
OPENCODE_TEAM_PYTHON="$(command -v python3)"
RUN_STATE_DIR="$STATE/run"
RUN_ID=deadbeef
PARENT_SESSION_ID=ses_recycle_fixture
SESSION_DIRECTORY="$STATE/workdir"
mkdir -p "$RUN_STATE_DIR" "$SESSION_DIRECTORY"

sleep 300 &
OLD_PID=$!
SERVER_PID=$OLD_PID
write_process_identity server "$OLD_PID"

start_server() {
  sleep 300 &
  NEW_PID=$!
  SERVER_PID=$NEW_PID
  write_process_identity server "$NEW_PID"
}
wait_server() { :; }

recycle_owned_server
[ "$SERVER_PID" != "$OLD_PID" ]
[ "$PARENT_SESSION_ID" = ses_recycle_fixture ]
[ "$SESSION_DIRECTORY" = "$STATE/workdir" ]
process_owned_by_run server "$SERVER_PID"

bad_state="$STATE/bad"
mkdir -p "$bad_state"
RUN_STATE_DIR="$bad_state"
printf 'pid=%s\nstart_epoch=wrong\npgid=1\nsid=1\nrole=server\nrun_id=%s\n' "$SERVER_PID" "$RUN_ID" > "$bad_state/server.identity"
if (SERVER_PID="$SERVER_PID" recycle_owned_server) 2>/dev/null; then
  printf '%s\n' 'identity mismatch was accepted' >&2
  exit 1
fi

printf '%s\n' 'recycle ownership: ok'
