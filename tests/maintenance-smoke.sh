#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -x /opt/homebrew/opt/node@22/bin/node ]; then
  PATH="/opt/homebrew/opt/node@22/bin:$PATH"
  export PATH
fi
CLI="${OPENCODE_TEAM_CLI:-$ROOT/bin/opencode-team}"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/opencode-team-maintenance.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

export OPENCODE_TEAM_HOME="$TEST_ROOT"
export OPENCODE_TEAM_DEPENDENCY_ROOT="${OPENCODE_TEAM_TEST_DEPENDENCY_ROOT:-${TMPDIR:-/tmp}/opencode-team-shared-dependencies-${USER:-$(id -u)}}"
export OPENCODE_TEAM_EXECUTABLE=/opt/homebrew/bin/opencode-team
"$CLI" setup >/tmp/opencode-team-maintenance-setup.out

agent_root="$TEST_ROOT/state/maintenance/launchagents"
for task in best-tool-output-gc best-retention openai-retention runtime-gc; do
  plist="$agent_root/it.danilodantoni.opencode-team.$task.plist"
  test -f "$plist"
  plutil -lint "$plist"
  rg -q "/opt/homebrew/bin/opencode-team" "$plist"
  ! rg -q '/Users/|\.opencode-team-staging|/Cellar/' "$plist"
done

before="$(shasum -a 256 "$agent_root"/*.plist)"
"$CLI" setup >/tmp/opencode-team-maintenance-setup-second.out

mkdir -p "$TEST_ROOT/no-legacy-home"
HOME="$TEST_ROOT/no-legacy-home" OPENCODE_TEAM_LEGACY_MAINTENANCE=1 "$CLI" setup >/tmp/opencode-team-maintenance-deferred.out
test "$(< "$TEST_ROOT/state/maintenance/status/best-tool-output-gc")" = DEFERRED
test "$(< "$TEST_ROOT/state/maintenance/status/best-retention")" = DEFERRED
test "$(< "$TEST_ROOT/state/maintenance/status/openai-retention")" = DEFERRED
test "$(< "$TEST_ROOT/state/maintenance/status/runtime-gc")" = INSTALLED
OPENCODE_TEAM_LEGACY_MAINTENANCE=1 "$CLI" maintenance status >"$TEST_ROOT/maintenance-status.out"
rg -q 'BEST tool-output GC  DEFERRED' "$TEST_ROOT/maintenance-status.out"

unset OPENCODE_TEAM_LEGACY_MAINTENANCE

legacy_home="$TEST_ROOT/legacy-home"
mkdir -p "$legacy_home/Library/LaunchAgents" "$legacy_home/.local/bin" "$legacy_home/.opencode-team-staging/unified-core-v1/teams/best"
cp "$ROOT/shared/maintenance/opencode-cleanup.py" "$legacy_home/.local/bin/opencode-cleanup"
chmod 0755 "$legacy_home/.local/bin/opencode-cleanup"
cp "$ROOT/teams/best/tool-output-gc.mjs" "$legacy_home/.opencode-team-staging/unified-core-v1/teams/best/tool-output-gc.mjs"
LEGACY_HOME="$legacy_home" python3 - <<'PY'
import os
import plistlib
from pathlib import Path

home = Path(os.environ["LEGACY_HOME"])
base = home / "Library" / "LaunchAgents"
cleanup = str(home / ".local" / "bin" / "opencode-cleanup")
jobs = {
    "com.thomasd.opencode-best-tool-output-gc": [str(home / ".opencode-team-staging" / "unified-core-v1" / "teams" / "best" / "tool-output-gc.mjs")],
    "com.thomasd.opencode-best-retention": [cleanup, "--retention-only", "--live-retention", "--team", "best", "--max-families", "1", "--max-session-deletes", "3"],
    "com.thomasd.opencode-retention": [cleanup, "--retention-only", "--live-retention", "--team", "openai", "--max-families", "3", "--max-session-deletes", "10"],
    "com.thomasd.opencode-cleanup": [cleanup],
}
for label, arguments in jobs.items():
    payload = {"Label": label, "ProgramArguments": arguments}
    with (base / f"{label}.plist").open("wb") as stream:
        plistlib.dump(payload, stream)
PY
HOME="$legacy_home" OPENCODE_TEAM_LEGACY_MAINTENANCE=1 "$CLI" setup >"$TEST_ROOT/legacy-migration.out"
rg -q 'best-retention.*OK' "$TEST_ROOT/legacy-migration.out"
rg -q 'openai-retention.*OK' "$TEST_ROOT/legacy-migration.out"
test ! -e "$legacy_home/Library/LaunchAgents/com.thomasd.opencode-best-retention.plist"
test ! -e "$legacy_home/Library/LaunchAgents/com.thomasd.opencode-retention.plist"
test ! -e "$legacy_home/Library/LaunchAgents/com.thomasd.opencode-cleanup.plist"
test -f "$TEST_ROOT/state/maintenance/launchagents/it.danilodantoni.opencode-team.best-retention.plist"
test -f "$TEST_ROOT/state/maintenance/launchagents/it.danilodantoni.opencode-team.openai-retention.plist"

LEGACY_HOME="$legacy_home" python3 - <<'PY'
import os
import plistlib
from pathlib import Path

home = Path(os.environ["LEGACY_HOME"])
path = home / "Library" / "LaunchAgents" / "com.thomasd.opencode-best-retention.plist"
payload = {
    "Label": "com.thomasd.opencode-best-retention",
    "ProgramArguments": [
        str(home / ".local" / "bin" / "opencode-cleanup"),
        "--retention-only", "--live-retention", "--team", "best",
        "--max-families", "1", "--max-session-deletes", "99",
    ],
}
with path.open("wb") as stream:
    plistlib.dump(payload, stream)
unknown = path.with_name("com.example.unrelated-maintenance.plist")
with unknown.open("wb") as stream:
    plistlib.dump({"Label": "com.example.unrelated-maintenance", "ProgramArguments": ["/bin/true"]}, stream)
PY
HOME="$legacy_home" OPENCODE_TEAM_LEGACY_MAINTENANCE=1 "$CLI" setup >"$TEST_ROOT/mutated-migration.out"
test -f "$legacy_home/Library/LaunchAgents/com.thomasd.opencode-best-retention.plist"
test -f "$legacy_home/Library/LaunchAgents/com.example.unrelated-maintenance.plist"
test "$(< "$TEST_ROOT/state/maintenance/status/best-retention")" = DEFERRED

lock_root="$TEST_ROOT/state/maintenance/locks"
mkdir -p "$lock_root"
current_start="$(LC_ALL=C ps -p "$$" -o lstart= | awk '{$1=$1; print}' | tr -s ' ' | tr ':' '_')"

# A live PID with a different start identity is a recycled PID, not an owner.
mkdir "$lock_root/best-tool-output-gc.lock"
cat >"$lock_root/best-tool-output-gc.lock/owner" <<EOF
pid=$$
process_start_identity=historical-$current_start
token=pid-reuse-fixture
created_epoch=$(date +%s)
EOF
"$CLI" maintenance best-tool-output-gc >"$TEST_ROOT/pid-reuse.out"
rg -q 'SKIP_NO_BEST_TOOL_OUTPUT_STORE' "$TEST_ROOT/pid-reuse.out"
test ! -e "$lock_root/best-tool-output-gc.lock"

# A dead PID with valid historical metadata is safely reclaimable.
mkdir "$lock_root/best-retention.lock"
cat >"$lock_root/best-retention.lock/owner" <<'EOF'
pid=99999999
process_start_identity=historical-owner
token=dead-owner-fixture
created_epoch=1
EOF
"$CLI" maintenance best-retention >"$TEST_ROOT/dead-owner.out"
test ! -e "$lock_root/best-retention.lock"

# Fresh incomplete publication is uncertain and must remain untouched.
mkdir "$lock_root/best-tool-output-gc.lock"
OPENCODE_MAINTENANCE_LOCK_GRACE_SECONDS=30 \
  "$CLI" maintenance best-tool-output-gc >"$TEST_ROOT/fresh-malformed.out"
rg -q 'SKIP_LOCK_UNCERTAIN task=best-tool-output-gc' "$TEST_ROOT/fresh-malformed.out"
test -d "$lock_root/best-tool-output-gc.lock"
rm -rf "$lock_root/best-tool-output-gc.lock"

# An old malformed lock is fenced and reclaimed rather than deleted in place.
mkdir "$lock_root/best-tool-output-gc.lock"
LOCK_DIR="$lock_root/best-tool-output-gc.lock" python3 - <<'PY'
import os
import time

path = os.environ["LOCK_DIR"]
old = time.time() - 10
os.utime(path, (old, old))
PY
"$CLI" maintenance best-tool-output-gc >"$TEST_ROOT/stale-malformed.out"
test ! -e "$lock_root/best-tool-output-gc.lock"

# A successor owner must survive cleanup by the fenced predecessor.
OPENCODE_MAINTENANCE_TEST_CLEANUP_DELAY_MS=500 "$CLI" maintenance best-tool-output-gc >"$TEST_ROOT/successor.out" &
successor_pid=$!
for _ in $(seq 1 100); do
  [ -f "$lock_root/best-tool-output-gc.lock/owner" ] && break
  sleep 0.01
done
test -f "$lock_root/best-tool-output-gc.lock/owner"
LOCK_DIR="$lock_root/best-tool-output-gc.lock" python3 - <<'PY'
import os
from pathlib import Path

path = Path(os.environ["LOCK_DIR"]) / "owner"
fields = {}
for line in path.read_text().splitlines():
    key, value = line.split("=", 1)
    fields[key] = value
fields["token"] = "successor-fixture"
path.write_text("".join(f"{key}={fields[key]}\n" for key in ("pid", "process_start_identity", "token", "created_epoch")))
PY
wait "$successor_pid"
test -d "$lock_root/best-tool-output-gc.lock"
rg -q '^token=successor-fixture$' "$lock_root/best-tool-output-gc.lock/owner"
rm -rf "$lock_root/best-tool-output-gc.lock"

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
"$CLI" maintenance runtime-gc >"$TEST_ROOT/runtime-gc-maintenance.out"
rg -q '"mode": "dry-run"|GC ' "$TEST_ROOT/runtime-gc-maintenance.out"

mkdir -p "$TEST_ROOT/state/maintenance/logs" "$TEST_ROOT/data/openai/state/team/logs"
python3 - "$TEST_ROOT/state/maintenance/logs/authorship-guard.log" "$TEST_ROOT/data/openai/state/team/logs/latency-metrics.jsonl" <<'PY'
import pathlib
import sys

for path in sys.argv[1:]:
    pathlib.Path(path).write_bytes(b"x" * 2048)
PY
OPENCODE_TEAM_LOG_MAX_BYTES=1024 OPENCODE_TEAM_LOG_ROTATIONS=2 "$CLI" maintenance runtime-gc >"$TEST_ROOT/runtime-gc-rotation.out"
test -f "$TEST_ROOT/state/maintenance/logs/authorship-guard.log.1"
test -f "$TEST_ROOT/data/openai/state/team/logs/latency-metrics.jsonl.1"
test ! -s "$TEST_ROOT/state/maintenance/logs/authorship-guard.log"

OPENCODE_TEAM_TEST_FREE_BYTES=1 OPENCODE_TEAM_MIN_FREE_DISK_BYTES=1000 "$CLI" storage-accounting >"$TEST_ROOT/storage-accounting.json"
jq -e '.warnings[] | select(.code == "LOW_FREE_DISK")' "$TEST_ROOT/storage-accounting.json" >/dev/null
jq -e '.categories["db-wal"].files | has("openai:opencode:opencode.db") and has("openai:codegraph:codegraph.db-wal")' "$TEST_ROOT/storage-accounting.json" >/dev/null

printf '%s\n' 'MAINTENANCE SMOKE PASS'
