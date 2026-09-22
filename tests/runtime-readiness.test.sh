#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/opencode-team-readiness.XXXXXX")"
RUNTIME_ROOT="$TEST_ROOT/cache/runtime"

cleanup() {
  local rc=$?

  for pid in "${launcher_pid:-}" "${server_pid:-}"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done

  for pid in "${launcher_pid:-}" "${server_pid:-}"; do
    if [ -n "$pid" ]; then
      wait "$pid" 2>/dev/null || true
    fi
  done

  rm -rf "$TEST_ROOT"
  return "$rc"
}

trap cleanup EXIT

start_fixture_processes() {
  sleep 120 &
  launcher_pid=$!
  sleep 120 &
  server_pid=$!
}

write_identity() {
  local run_dir="$1" role="$2" pid="$3" start_epoch
  start_epoch="$(node - "$pid" <<'NODE'
const { spawnSync } = require("node:child_process");
const result = spawnSync("ps", ["-p", process.argv[2], "-o", "lstart="], {
  encoding: "utf8",
  env: { ...process.env, LC_ALL: "C", LANG: "C" },
});
if (result.status !== 0) process.exit(1);
const epoch = Date.parse(result.stdout.trim());
if (!Number.isFinite(epoch)) process.exit(1);
process.stdout.write(String(Math.floor(epoch / 1000)));
NODE
)"
  printf 'pid=%s\nstart_epoch=%s\nrole=%s\nrun_id=abcd1234\n' "$pid" "$start_epoch" "$role" >"$run_dir/$role.identity"
}

start_fixture_processes
run_dir="$RUNTIME_ROOT/best/runs/abcd1234"
mkdir -p "$run_dir"
printf '%s\n' abcd1234 >"$run_dir/run_id"
printf '%s\n' best >"$run_dir/team"
printf '%s\n' interactive >"$run_dir/job_type"
printf '%s\n' "$RUNTIME_ROOT" >"$run_dir/runtime_root"
printf '%s\n' ACTIVE >"$run_dir/state"
write_identity "$run_dir" launcher "$launcher_pid"
write_identity "$run_dir" server "$server_pid"
PACKAGE_ROOT="$ROOT" node "$ROOT/core/lib/runtime-manifest.mjs" "$run_dir" publish
printf '%s\n' ses_readiness >"$run_dir/parent_session_id"
PACKAGE_ROOT="$ROOT" node "$ROOT/core/lib/runtime-manifest.mjs" "$run_dir" state ACTIVE

ready="$(PACKAGE_ROOT="$ROOT" RUNTIME_ROOT="$RUNTIME_ROOT" node "$ROOT/core/lib/runtime-lifecycle.mjs" readiness)"
printf '%s\n' "$ready" | jq -e '.ready == true' >/dev/null
printf '%s\n' 'REAL_RUNTIME_READY = PASS'

kill "$server_pid"
wait "$server_pid" 2>/dev/null || true
rm -rf "$RUNTIME_ROOT/best"
run_dir="$RUNTIME_ROOT/go/runs/abcd1234"
mkdir -p "$run_dir"
cat >"$run_dir/manifest.json" <<EOF
{"schema_version":1,"run_id":"abcd1234","team":"go","state":"ACTIVE","runtime_root":"$RUNTIME_ROOT","parent_session_id":"ses_readiness"}
EOF
write_identity "$run_dir" launcher "$launcher_pid"
kill -0 "$launcher_pid"
not_ready="$(PACKAGE_ROOT="$ROOT" RUNTIME_ROOT="$RUNTIME_ROOT" node "$ROOT/core/lib/runtime-lifecycle.mjs" readiness)"
printf '%s\n' "$not_ready" | jq -e '.ready == false and .runs[0].reason == "incomplete_initialization"' >/dev/null
printf '%s\n' 'ALIVE_NOT_READY_NEGATIVE = PASS'
