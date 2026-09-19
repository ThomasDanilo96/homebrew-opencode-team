#!/bin/bash
set -uo pipefail

RUN_STATE_DIR="${1:-}"
CORE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$CORE_DIR/runtime-manifest.mjs"
[ -d "$RUN_STATE_DIR" ] || exit 1

read_field() { sed -n "s/^$2=//p" "$RUN_STATE_DIR/$1.identity" 2>/dev/null | head -n 1; }
read_pid() { cat "$RUN_STATE_DIR/$1.pid" 2>/dev/null; }
process_start_epoch() {
  local pid="$1" raw
  raw=$(LC_ALL=C ps -p "$pid" -o lstart= 2>/dev/null) || return 1
  [ -n "$raw" ] || return 1
  printf '%s\n' "$raw" | python3 -c 'import sys,time; print(int(time.mktime(time.strptime(sys.stdin.read().strip(), "%a %b %d %H:%M:%S %Y"))))' 2>/dev/null
}
process_alive() {
  local pid="$1" stat
  kill -0 "$pid" 2>/dev/null || return 1
  stat="$(ps -p "$pid" -o stat= 2>/dev/null | tr -d ' ')"
  [ -n "$stat" ] && [ "${stat#Z}" = "$stat" ]
}
identity_matches() {
  local role="$1" pid start pgid sid
  pid="$(read_pid "$role")"
  [ -n "$pid" ] || return 1
  [ "$(read_field "$role" role)" = "$role" ] || return 1
  [ "$(read_field "$role" pid)" = "$pid" ] || return 1
  [ "$(read_field "$role" run_id)" = "$(< "$RUN_STATE_DIR/run_id")" ] || return 1
  process_alive "$pid" || return 1
  start="$(process_start_epoch "$pid" || true)"
  pgid="$(ps -p "$pid" -o pgid= 2>/dev/null | tr -d ' ')"
  sid="$(ps -p "$pid" -o sess= 2>/dev/null | tr -d ' ')"
  [ -n "$start" ] && [ "$start" = "$(read_field "$role" start_epoch)" ] || return 1
  [ "$pgid" = "$(read_field "$role" pgid)" ] && [ "$sid" = "$(read_field "$role" sid)" ]
}
pid_is_uncertain() {
  local role="$1" pid
  pid="$(read_pid "$role")"
  [ -z "$pid" ] && return 1
  process_alive "$pid" && ! identity_matches "$role"
}
signal_owned() {
  local role="$1" signal="$2" pid
  pid="$(read_pid "$role")"
  [ -n "$pid" ] && identity_matches "$role" || return 1
  kill -"$signal" "$pid" 2>/dev/null
}
wait_owned_exit() {
  local role="$1" ticks=50
  while [ "$ticks" -gt 0 ]; do
    identity_matches "$role" || return 0
    sleep 0.1
    ticks=$((ticks - 1))
  done
  return 1
}
set_state() {
  printf '%s\n' "$1" >"$RUN_STATE_DIR/state"
  node "$MANIFEST" "$RUN_STATE_DIR" state "$1" >/dev/null 2>&1 || true
}

launcher_pid="$(read_pid launcher)"
[ -n "$launcher_pid" ] || { set_state UNCERTAIN; exit 0; }
while true; do
  if identity_matches launcher; then
    node "$MANIFEST" "$RUN_STATE_DIR" heartbeat >/dev/null 2>&1 || true
    sleep 2
    continue
  fi
  if process_alive "$launcher_pid"; then
    set_state UNCERTAIN
    exit 0
  fi
  set_state ORPHANED
  uncertain=0
  for role in bridge attach server watchdog; do
    pid="$(read_pid "$role")"
    [ -n "$pid" ] || continue
    if pid_is_uncertain "$role"; then
      uncertain=1
      continue
    fi
    if identity_matches "$role"; then
      signal_owned "$role" TERM || true
      if ! wait_owned_exit "$role"; then
        if identity_matches "$role"; then kill -KILL "$pid" 2>/dev/null || true; fi
        wait_owned_exit "$role" || uncertain=1
      fi
    fi
  done
  if [ "$uncertain" -eq 1 ]; then set_state UNCERTAIN; else set_state RECLAIMABLE; fi
  exit 0
done
