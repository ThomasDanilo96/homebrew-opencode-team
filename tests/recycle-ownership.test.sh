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

FAKE_BIN="$STATE/fake-bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/ps" <<'SH'
#!/usr/bin/env bash
exit 1
SH
chmod +x "$FAKE_BIN/ps"
ORIGINAL_PATH="$PATH"
PATH="$FAKE_BIN:$PATH" write_process_identity watchdog "$$"
grep -qx 'start_epoch=0' "$RUN_STATE_DIR/watchdog.identity"
PATH="$FAKE_BIN:$PATH" process_owned_by_run watchdog "$$"
PATH="$ORIGINAL_PATH"

REAL_PYTHON="$OPENCODE_TEAM_PYTHON"
FAKE_PYTHON="$FAKE_BIN/python-deny-socket"
cat > "$FAKE_PYTHON" <<SH
#!/usr/bin/env bash
if [ "\${1:-}" = "-c" ]; then
  case "\${2:-}" in
    *'s.bind(("127.0.0.1",0))'*)
      printf '%s\n' 'PermissionError: [Errno 1] Operation not permitted' >&2
      exit 1
      ;;
  esac
fi
exec "$REAL_PYTHON" "\$@"
SH
chmod +x "$FAKE_PYTHON"
OPENCODE_TEAM_PYTHON="$FAKE_PYTHON"
PORT="$(allocate_port)"
OPENCODE_TEAM_PYTHON="$REAL_PYTHON"
case "$PORT" in ''|*[!0-9]*) exit 1 ;; esac
[ "$PORT" -ge 49152 ] && [ "$PORT" -le 65535 ]

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
