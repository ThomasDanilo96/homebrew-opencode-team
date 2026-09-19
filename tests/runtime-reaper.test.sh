#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! ps -p $$ -o lstart= >/dev/null 2>&1; then
  printf '%s\n' 'runtime reaper: skipped (ps unavailable in sandbox)'
  exit 0
fi
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/opencode-team-reaper.XXXXXX")"
trap 'kill "$launcher" "$server" "$bridge" "$reaper" 2>/dev/null || true; rm -rf "$TEST_ROOT"' EXIT INT TERM

run_dir="$TEST_ROOT/run"
mkdir -p "$run_dir"
printf '%s\n' 1 >"$run_dir/run_id"

write_identity() {
  local role="$1" pid="$2" start pgid sid
  start="$(LC_ALL=C ps -p "$pid" -o lstart= | awk '{$1=$1; print}' | tr -s ' ')"
  pgid="$(ps -p "$pid" -o pgid= | tr -d ' ')"
  sid="$(ps -p "$pid" -o sess= | tr -d ' ')"
  printf 'pid=%s\nstart_epoch=%s\npgid=%s\nsid=%s\nrole=%s\nrun_id=1\n' \
    "$pid" "$(python3 -c "import time; print(int(time.mktime(time.strptime('$start', '%a %b %d %H:%M:%S %Y'))))")" "$pgid" "$sid" "$role" >"$run_dir/$role.identity"
  printf '%s\n' "$pid" >"$run_dir/$role.pid"
}

sleep 300 & launcher=$!
sleep 300 & server=$!
sleep 300 & bridge=$!
write_identity launcher "$launcher"
write_identity server "$server"
write_identity bridge "$bridge"

"$ROOT/core/lib/runtime-reaper.sh" "$run_dir" >"$TEST_ROOT/reaper.out" 2>"$TEST_ROOT/reaper.err" & reaper=$!
kill -9 "$launcher"

for _ in $(seq 1 100); do
  if [ -f "$run_dir/state" ] && [ "$(< "$run_dir/state")" = RECLAIMABLE ]; then break; fi
  sleep 0.1
done

test "$(< "$run_dir/state")" = RECLAIMABLE
! kill -0 "$server" 2>/dev/null
! kill -0 "$bridge" 2>/dev/null
printf '%s\n' 'runtime reaper: ok'
