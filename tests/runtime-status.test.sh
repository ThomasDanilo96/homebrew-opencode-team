#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/opencode-team-runtime-status.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

export PACKAGE_ROOT="$ROOT"
export RUNTIME_ROOT="$TEST_ROOT/runtime"
export DATA_ROOT="$TEST_ROOT/data"
export STATE_ROOT="$TEST_ROOT/state"
export CACHE_ROOT="$TEST_ROOT/cache"

run_dir="$RUNTIME_ROOT/runs/12345678"
mkdir -p "$run_dir"
printf '%s\n' 12345678 >"$run_dir/run_id"
printf '%s\n' best >"$run_dir/team"
printf '%s\n' interactive >"$run_dir/job_type"
printf '%s\n' "$RUNTIME_ROOT" >"$run_dir/runtime_root"
printf '%s\n' "$(date -u -v-90S '+%Y-%m-%dT%H:%M:%SZ')" >"$run_dir/created_at"
printf '%s\n' ACTIVE >"$run_dir/state"
printf '%s\n' initializing >"$run_dir/stage"
printf '%s\n' ses_runtime_status >"$run_dir/parent_session_id"
for role in launcher server bridge reaper; do
  printf 'pid=99999999\nstart_epoch=1\npgid=1\nsid=1\nrole=%s\nrun_id=12345678\n' "$role" >"$run_dir/$role.identity"
done

node "$ROOT/core/lib/runtime-manifest.mjs" "$run_dir" publish >/dev/null
status_json="$(node "$ROOT/core/lib/runtime-lifecycle.mjs" status)"
jq -e '.runs[0].status == "STARTING" and .runs[0].stage == "initializing" and .runs[0].active_child_session_id == null' <<<"$status_json" >/dev/null
node "$ROOT/core/lib/runtime-manifest.mjs" "$run_dir" status active >/dev/null
status_json="$(node "$ROOT/core/lib/runtime-lifecycle.mjs" status)"
jq -e '.runs[0].status == "RUNNING" and .runs[0].stage == "active" and .runs[0].parent_session_id == "ses_runtime_status" and .runs[0].active_child_session_id == null and (.runs[0].elapsed_seconds >= 90) and .runs[0].failure_reason == null and .runs[0].status_source == "runtime-state"' <<<"$status_json" >/dev/null

printf '%s\n' waiting_child >"$run_dir/stage"
printf '%s\n' ses_child >"$run_dir/active_child_session_id"
printf '%s\n' codex_executor >"$run_dir/active_child_agent"
node "$ROOT/core/lib/runtime-manifest.mjs" "$run_dir" heartbeat >/dev/null
status_json="$(node "$ROOT/core/lib/runtime-lifecycle.mjs" status)"
jq -e '.runs[0].status == "WAITING_CHILD" and .runs[0].active_child_session_id == "ses_child" and .runs[0].active_child_agent == "codex_executor" and .runs[0].parent_session_id != .runs[0].active_child_session_id' <<<"$status_json" >/dev/null

printf '%s\n' verifying >"$run_dir/stage"
rm -f "$run_dir/active_child_agent"
node "$ROOT/core/lib/runtime-manifest.mjs" "$run_dir" heartbeat >/dev/null
status_json="$(node "$ROOT/core/lib/runtime-lifecycle.mjs" status)"
jq -e '.runs[0].status == "VERIFYING" and .runs[0].active_child_session_id == "ses_child"' <<<"$status_json" >/dev/null

node "$ROOT/core/lib/runtime-manifest.mjs" "$run_dir" status failed "" "server exited with code 7" >/dev/null
status_json="$(node "$ROOT/core/lib/runtime-lifecycle.mjs" status)"
jq -e '.runs[0].status == "FAILED" and .runs[0].stage == "failed" and .runs[0].active_child_session_id == null and .runs[0].failure_reason == "server exited with code 7" and (.runs[0].elapsed_seconds >= 90)' <<<"$status_json" >/dev/null
history_json="$(RUNTIME_ROOT="$RUNTIME_ROOT" node "$ROOT/core/lib/runtime-lifecycle.mjs" history)"
jq -e '.records[0].status == "FAILED" and .records[0].failure_reason == "server exited with code 7" and .records[0].timeout_reason == null and .records[0].ended_at != null' <<<"$history_json" >/dev/null

printf '%s\n' timed_out >"$run_dir/stage"
printf '%s\n' provider-timeout >"$run_dir/timeout_reason"
node "$ROOT/core/lib/runtime-manifest.mjs" "$run_dir" status timed_out >/dev/null
status_json="$(node "$ROOT/core/lib/runtime-lifecycle.mjs" status)"
jq -e '.runs[0].status == "TIMED_OUT" and .runs[0].failure_reason == null and .runs[0].timeout_reason == "provider-timeout"' <<<"$status_json" >/dev/null
history_json="$(RUNTIME_ROOT="$RUNTIME_ROOT" node "$ROOT/core/lib/runtime-lifecycle.mjs" history)"
jq -e '.records[0].status == "TIMED_OUT" and .records[0].failure_reason == null and .records[0].timeout_reason == "provider-timeout" and .records[0].ended_at != null' <<<"$history_json" >/dev/null

node "$ROOT/core/lib/runtime-manifest.mjs" "$run_dir" status stopped >/dev/null
status_json="$(node "$ROOT/core/lib/runtime-lifecycle.mjs" status)"
jq -e '.runs[0].status == "COMPLETED" and .runs[0].stage == "stopped" and .runs[0].active_child_session_id == null' <<<"$status_json" >/dev/null
history_json="$(RUNTIME_ROOT="$RUNTIME_ROOT" node "$ROOT/core/lib/runtime-lifecycle.mjs" history)"
jq -e '.records[0].status == "COMPLETED" and .records[0].stage == "stopped" and .records[0].failure_reason == null and .records[0].timeout_reason == null' <<<"$history_json" >/dev/null

printf '%s\n' 'runtime status: ok'
