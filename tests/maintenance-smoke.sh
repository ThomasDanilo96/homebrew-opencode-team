#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="${OPENCODE_TEAM_CLI:-$ROOT/bin/opencode-team}"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/opencode-team-maintenance.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

export OPENCODE_TEAM_HOME="$TEST_ROOT"
export OPENCODE_TEAM_EXECUTABLE=/opt/homebrew/bin/opencode-team
"$CLI" setup >/tmp/opencode-team-maintenance-setup.out

agent_root="$TEST_ROOT/state/maintenance/launchagents"
for task in best-tool-output-gc best-retention openai-retention; do
  plist="$agent_root/it.danilodantoni.opencode-team.$task.plist"
  test -f "$plist"
  plutil -lint "$plist"
  rg -q "/opt/homebrew/bin/opencode-team" "$plist"
  ! rg -q '/Users/thomasd|\.opencode-team-staging|/Cellar/' "$plist"
done

before="$(shasum -a 256 "$agent_root"/*.plist)"
"$CLI" setup >/tmp/opencode-team-maintenance-setup-second.out

OPENCODE_TEAM_LEGACY_MAINTENANCE=1 "$CLI" setup >/tmp/opencode-team-maintenance-deferred.out
test "$(< "$TEST_ROOT/state/maintenance/status/best-tool-output-gc")" = DEFERRED
test "$(< "$TEST_ROOT/state/maintenance/status/best-retention")" = DEFERRED
test "$(< "$TEST_ROOT/state/maintenance/status/openai-retention")" = DEFERRED
OPENCODE_TEAM_LEGACY_MAINTENANCE=1 "$CLI" maintenance status | rg -q 'BEST tool-output GC  DEFERRED'

unset OPENCODE_TEAM_LEGACY_MAINTENANCE
state_root="$TEST_ROOT/data/openai/state/team"
mkdir -p "$state_root/work-packets" "$state_root/codex-recovery" "$state_root/logs" "$state_root/locks" "$state_root/active"
TEST_STATE_ROOT="$state_root" python3 - <<'PY'
import json
import os
import time
from pathlib import Path

root = Path(os.environ["TEST_STATE_ROOT"])
old = "2000000000000000000000000000000000000000000000000000000000000001"
recent = "2000000000000000000000000000000000000000000000000000000000000002"
active = "2000000000000000000000000000000000000000000000000000000000000003"
malformed = "2000000000000000000000000000000000000000000000000000000000000004"
stamp = "2020-01-01T00:00:00.000Z"
now = "2099-01-01T00:00:00.000Z"
packet = {"schema_version": 2, "phase": "foreground_completion", "outcome": "completed", "completed_at": stamp, "tester_status": "passed"}
(root / "work-packets" / f"{old}.json").write_text(json.dumps(packet))
(root / "work-packets" / f"{recent}.json").write_text(json.dumps({**packet, "completed_at": now}))
(root / "work-packets" / f"{active}.json").write_text(json.dumps({"schema_version": 2, "phase": "admitted", "outcome": "pending"}))
(root / "work-packets" / f"{malformed}.json").write_text("not-json")
(root / "codex-recovery" / "sealed-old.json").write_text(json.dumps({"termination_sealed": True, "journal_scan_complete": True}))
(root / "logs" / "old.jsonl").write_text("old\n")
(root / "logs" / "recent.jsonl").write_text("recent\n")
old_time = time.time() - 10 * 86400
os.utime(root / "work-packets" / f"{old}.json", (old_time, old_time))
os.utime(root / "logs" / "old.jsonl", (old_time, old_time))
PY
openai_output="$TEST_ROOT/openai-retention.out"
"$CLI" maintenance openai-retention >"$openai_output"
test ! -e "$state_root/work-packets/2000000000000000000000000000000000000000000000000000000000000001.json"
test -e "$state_root/work-packets/2000000000000000000000000000000000000000000000000000000000000002.json"
test -e "$state_root/work-packets/2000000000000000000000000000000000000000000000000000000000000003.json"
test -e "$state_root/work-packets/2000000000000000000000000000000000000000000000000000000000000004.json"
test -e "$state_root/codex-recovery/sealed-old.json"
test ! -e "$state_root/logs/old.jsonl"
test -e "$state_root/logs/recent.jsonl"
rg -q '^work_packets_deleted=1$' "$openai_output"
rg -q '^logs_pruned=1$' "$openai_output"

OPENCODE_MAINTENANCE_TEST_DELAY_MS=500 "$CLI" maintenance best-tool-output-gc >/tmp/opencode-team-best-lock.out &
best_pid=$!
sleep 0.1
"$CLI" maintenance best-tool-output-gc >"$TEST_ROOT/best-lock-skip.out"
rg -q 'SKIP_ALREADY_RUNNING' "$TEST_ROOT/best-lock-skip.out"
wait "$best_pid"

OPENCODE_MAINTENANCE_TEST_DELAY_MS=500 "$CLI" maintenance openai-retention >/tmp/opencode-team-openai-lock.out &
openai_pid=$!
sleep 0.1
"$CLI" maintenance openai-retention >"$TEST_ROOT/openai-lock-skip.out"
rg -q 'SKIP_ALREADY_RUNNING' "$TEST_ROOT/openai-lock-skip.out"
wait "$openai_pid"

"$CLI" maintenance best-tool-output-gc >"$TEST_ROOT/best-empty.out"
rg -q 'SKIP_NO_BEST_TOOL_OUTPUT_STORE' "$TEST_ROOT/best-empty.out"
"$CLI" maintenance best-retention >/dev/null
"$CLI" maintenance openai-retention >/dev/null

printf '%s\n' 'MAINTENANCE SMOKE PASS'
