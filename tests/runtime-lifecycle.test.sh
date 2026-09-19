#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -x /opt/homebrew/opt/node@22/bin/node ]; then
  PATH="/opt/homebrew/opt/node@22/bin:$PATH"
  export PATH
fi
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/opencode-team-lifecycle.XXXXXX")"
cleanup() {
  kill ${active_pid:-} ${open_pid:-} ${concurrent_pids:-} 2>/dev/null || true
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT INT TERM

export OPENCODE_TEAM_HOME="$TEST_ROOT/home"
export OPENCODE_TEAM_DEPENDENCY_ROOT="$TEST_ROOT/shared-dependencies"
export OPENCODE_TEAM_TEST_FREE_BYTES=1
export OPENCODE_TEAM_MIN_FREE_DISK_BYTES=1000
PS_AVAILABLE=0
if ps -p $$ -o lstart= >/dev/null 2>&1; then
  PS_AVAILABLE=1
fi

runtime_root="$OPENCODE_TEAM_HOME/cache/runtime"
runs_root="$runtime_root/best/runs"
mkdir -p "$runs_root" "$OPENCODE_TEAM_HOME/data/best/data/opencode"

start_epoch() {
  local pid="$1" raw
  raw="$(LC_ALL=C ps -p "$pid" -o lstart= | awk '{$1=$1; print}' | tr -s ' ')"
  python3 -c "import time; print(int(time.mktime(time.strptime('$raw', '%a %b %d %H:%M:%S %Y'))))"
}

write_identity() {
  local run_dir="$1" role="$2" pid="$3" run_id="$4" start pgid sid
  start="$(start_epoch "$pid")"
  pgid="$(ps -p "$pid" -o pgid= | tr -d ' ')"
  sid="$(ps -p "$pid" -o sess= | tr -d ' ')"
  printf 'pid=%s\nstart_epoch=%s\npgid=%s\nsid=%s\nrole=%s\nrun_id=%s\n' "$pid" "$start" "$pgid" "$sid" "$role" "$run_id" >"$run_dir/$role.identity"
  printf '%s\n' "$pid" >"$run_dir/$role.pid"
}

make_run() {
  local run_id="$1" state="$2" run_dir
  run_dir="$runs_root/$run_id"
  mkdir -p "$run_dir"
  printf '%s\n' "$run_id" >"$run_dir/run_id"
  printf '%s\n' best >"$run_dir/team"
  printf '%s\n' "$state" >"$run_dir/state"
  printf '%s\n' "$runtime_root/best" >"$run_dir/runtime_root"
  printf '%s\n' "$PPID" >"$run_dir/parent_pid"
  printf '%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >"$run_dir/created_at"
  for role in launcher server bridge reaper; do
    printf 'pid=99999999\nstart_epoch=1\npgid=1\nsid=1\nrole=%s\nrun_id=%s\n' "$role" "$run_id" >"$run_dir/$role.identity"
    printf '%s\n' 99999999 >"$run_dir/$role.pid"
  done
  node "$ROOT/core/lib/runtime-manifest.mjs" "$run_dir" publish
  printf '%s\n' "$run_dir"
}

stale_dir="$(make_run aaaaaaaa RECLAIMABLE)"
open_dir="$(make_run bbbbbbbb RECLAIMABLE)"
mismatch_dir="$(make_run cccccccc RECLAIMABLE)"
active_dir="$(make_run dddddddd RECLAIMABLE)"
manifest_dir="$(make_run eeeeeeee RECLAIMABLE)"
malformed_dir="$runs_root/ffffffff"
mkdir -p "$malformed_dir"
printf '%s\n' '{"schema_version":1,"run_id":"not-valid"}' >"$malformed_dir/manifest.json"

if [ "$PS_AVAILABLE" = 1 ]; then
  sleep 300 & active_pid=$!
  write_identity "$active_dir" server "$active_pid" dddddddd
fi

concurrent_dirs=()
concurrent_pids=""
for run_id in 10000001 10000002 10000003 10000004; do
  concurrent_dir="$(make_run "$run_id" ACTIVE)"
  concurrent_dirs+=("$concurrent_dir")
  if [ "$PS_AVAILABLE" = 1 ]; then
    sleep 300 & concurrent_pid=$!
    concurrent_pids="$concurrent_pids $concurrent_pid"
    write_identity "$concurrent_dir" server "$concurrent_pid" "$run_id"
  fi
done

printf 'pid=%s\nstart_epoch=1\npgid=1\nsid=1\nrole=server\nrun_id=cccccccc\n' "$$" >"$mismatch_dir/server.identity"
printf '%s\n' "$$" >"$mismatch_dir/server.pid"

printf '%s\n' held >"$open_dir/open.log"
LSOF_OPEN_AVAILABLE=0
python3 - "$open_dir/open.log" <<'PY' &
import pathlib
import sys
import time

handle = pathlib.Path(sys.argv[1]).open("r")
time.sleep(300)
handle.close()
PY
open_pid=$!
for _ in $(seq 1 50); do
  if /usr/sbin/lsof "$open_dir/open.log" >/dev/null 2>&1; then
    LSOF_OPEN_AVAILABLE=1
    break
  fi
  sleep 0.1
done

printf '%s\n' "$$" >"$manifest_dir/launcher.pid"
printf 'pid=99999999\nstart_epoch=1\npgid=1\nsid=1\nrole=launcher\nrun_id=eeeeeeee\n' >"$manifest_dir/launcher.identity"
printf '%s\n' 4242 >"$manifest_dir/parent_pid"
node "$ROOT/core/lib/runtime-manifest.mjs" "$manifest_dir" publish
jq -e '.parent_pid == 4242 and .launcher_pid != .parent_pid' "$manifest_dir/manifest.json" >/dev/null

"$ROOT/bin/opencode-team" runtime-gc >"$TEST_ROOT/gc-dry-run.out"
rg -q 'GC DELETE best/runs/aaaaaaaa reason=proven_inactive' "$TEST_ROOT/gc-dry-run.out"
if [ "$LSOF_OPEN_AVAILABLE" = 1 ]; then
  rg -q 'GC KEEP best/runs/bbbbbbbb reason=open_file' "$TEST_ROOT/gc-dry-run.out"
fi
rg -q 'GC UNCERTAIN best/runs/cccccccc reason=process_identity_mismatch' "$TEST_ROOT/gc-dry-run.out"
if [ "$PS_AVAILABLE" = 1 ]; then
  rg -q 'GC KEEP best/runs/dddddddd reason=live_process' "$TEST_ROOT/gc-dry-run.out"
fi
rg -q 'GC UNCERTAIN best/runs/ffffffff reason=malformed' "$TEST_ROOT/gc-dry-run.out"

"$ROOT/bin/opencode-team" runtime-gc --apply >"$TEST_ROOT/gc-apply.out"
test ! -d "$stale_dir"
if [ "$LSOF_OPEN_AVAILABLE" = 1 ]; then
  test -d "$open_dir"
fi
test -d "$mismatch_dir"
if [ "$PS_AVAILABLE" = 1 ]; then
  test -d "$active_dir"
  kill -0 "$active_pid"
fi
test -d "$malformed_dir"

if [ "$PS_AVAILABLE" = 1 ]; then
  run2_pid="$(printf '%s' "$concurrent_pids" | awk '{print $2}')"
  kill "$run2_pid"
  concurrent_dirs[1]="$runs_root/10000002"
  printf '%s\n' RECLAIMABLE >"${concurrent_dirs[1]}/state"
  node "$ROOT/core/lib/runtime-manifest.mjs" "${concurrent_dirs[1]}" state RECLAIMABLE >/dev/null
  "$ROOT/bin/opencode-team" runtime-gc --apply >"$TEST_ROOT/four-runtime-gc.out"
  test ! -d "${concurrent_dirs[1]}"
  for index in 0 2 3; do
    test -d "${concurrent_dirs[$index]}"
    keep_pid="$(printf '%s' "$concurrent_pids" | awk -v position=$((index + 1)) '{print $position}')"
    kill -0 "$keep_pid"
  done
  printf '%s\n' 'FOUR_CONCURRENT=PASS' >>"$TEST_ROOT/acceptance.txt"
fi

"$ROOT/bin/opencode-team" runtime-status >"$TEST_ROOT/runtime-status.json"
jq -e '.storage.warnings[] | select(.code == "LOW_FREE_DISK")' "$TEST_ROOT/runtime-status.json" >/dev/null
jq -e '.storage.categories["shared-team-dependencies"]' "$TEST_ROOT/runtime-status.json" >/dev/null
if OPENCODE_TEAM_QUOTA_AGGREGATE_BYTES=1 "$ROOT/bin/opencode-team" runtime-quota >"$TEST_ROOT/quota.json"; then
  printf '%s\n' 'quota guard unexpectedly allowed an exceeded aggregate' >&2
  exit 1
fi
jq -e '.warnings[] | select(.code == "DISPOSABLE_QUOTA")' "$TEST_ROOT/quota.json" >/dev/null
printf '%s\n' 'LOW_DISK_WARNING=PASS' >"$TEST_ROOT/acceptance.txt"
printf '%s\n' 'LOW_DISK_HARD_GUARD=PASS' >>"$TEST_ROOT/acceptance.txt"
printf '%s\n' 'QUOTA_EXCEEDED=PASS' >>"$TEST_ROOT/acceptance.txt"

printf '%s\n' sqlite >"$OPENCODE_TEAM_HOME/data/best/data/opencode/opencode.db"
printf '%s\n' wal >"$OPENCODE_TEAM_HOME/data/best/data/opencode/opencode.db-wal"
printf '%s\n' graph >"$OPENCODE_TEAM_HOME/data/best/data/opencode/codegraph.db"
printf '%s\n' graphwal >"$OPENCODE_TEAM_HOME/data/best/data/opencode/codegraph.db-wal"
"$ROOT/bin/opencode-team" storage-accounting >"$TEST_ROOT/storage.json"
jq -e '.categories["db-wal"].files["best:opencode:opencode.db"].bytes > 0' "$TEST_ROOT/storage.json" >/dev/null
jq -e '.categories["db-wal"].files["best:codegraph:codegraph.db-wal"].bytes > 0' "$TEST_ROOT/storage.json" >/dev/null
test -f "$OPENCODE_TEAM_HOME/data/best/data/opencode/codegraph.db"

mkdir -p "$TEST_ROOT/legacy"
printf '%s\n' legacy >"$TEST_ROOT/legacy/cache.log"
fixture_root="$TEST_ROOT/legacy-siblings"
mkdir -p "$fixture_root"
for fixture in opencode-team-setup.TEST opencode-daily-cert.TEST openai-daily-test.TEST com.apple.ap.promotedcontentd com.openai.codex com.openai.chat unrelated-app-cache random-user-file; do
  printf '%s\n' fixture >"$fixture_root/$fixture"
done
"$ROOT/bin/opencode-team" legacy-classify \
  "$fixture_root/opencode-team-setup.TEST" \
  "$fixture_root/opencode-daily-cert.TEST" \
  "$fixture_root/com.apple.ap.promotedcontentd" \
  "$fixture_root/unrelated-app-cache" \
  "$fixture_root/random-user-file" >"$TEST_ROOT/legacy.json"
jq -e 'all(.[0:3][]; .classification == "legacy-reclaimable-read-only")' "$TEST_ROOT/legacy.json" >/dev/null
jq -e 'all(.[3:][]; .classification == "legacy-uncertain")' "$TEST_ROOT/legacy.json" >/dev/null
printf '%s\n' symlink >"$TEST_ROOT/legacy-target"
ln -s "$TEST_ROOT/legacy-target" "$TEST_ROOT/opencode-team-symlink.TEST"
"$ROOT/bin/opencode-team" legacy-classify "$open_dir" "$TEST_ROOT/opencode-team-symlink.TEST" >"$TEST_ROOT/legacy-safety.json"
jq -e '.[0].classification == "legacy-active" and .[1].classification == "legacy-uncertain"' "$TEST_ROOT/legacy-safety.json" >/dev/null
test -f "$TEST_ROOT/legacy/cache.log"

"$ROOT/bin/opencode-team" time-machine-exclude >"$TEST_ROOT/tm.json"
jq -e 'all(.[]; .mode == "dry-run" and .child_covered == true)' "$TEST_ROOT/tm.json" >/dev/null

residue_count="$(find "$runtime_root" -type d -name aaaaaaaa -print | wc -l | tr -d ' ')"
test "$residue_count" = 0
printf '%s\n' 'RUNTIME LIFECYCLE PASS'
