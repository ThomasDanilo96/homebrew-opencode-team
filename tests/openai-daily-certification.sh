#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -x /opt/homebrew/opt/node@22/bin/node ]; then
  PATH="/opt/homebrew/opt/node@22/bin:$PATH"
  export PATH
fi

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/opencode-daily-cert.XXXXXX")"
TEAM_HOME="$TEST_ROOT/team-home"
DEP_ROOT="${OPENCODE_TEAM_TEST_DEPENDENCY_ROOT:-${TMPDIR:-/tmp}/opencode-team-shared-dependencies-${USER:-$(id -u)}}"
DIAGNOSTICS_DIR="${OPENAI_DAILY_CERTIFICATION_DIAGNOSTICS_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/opencode-daily-cert-diagnostics.XXXXXX")}"
RUNTIME_SESSION=""
RUNTIME_PID=""
SERVER_PID=""
BRIDGE_PID=""
WATCHDOG_PID=""
REAPER_PID=""
RUN_STATE_DIR=""
PREFLIGHT_PID=""
PRESERVE_TEST_ROOT="${OPENAI_DAILY_CERTIFICATION_KEEP_ARTIFACTS:-0}"
FAILED=0

copy_bounded() {
  local source="$1" destination="$2" max_bytes="${3:-200000}"
  [ -f "$source" ] || return 0
  mkdir -p "$(dirname "$destination")"
  python3 - "$source" "$destination" "$max_bytes" <<'PY'
import pathlib
import sys

source = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
limit = int(sys.argv[3])
data = source.read_bytes()
if len(data) > limit:
    data = data[: limit // 2] + b"\n...[truncated]...\n" + data[-(limit // 2):]
destination.write_bytes(data)
PY
}

cap_diagnostics() {
  local cap="${OPENAI_DAILY_CERTIFICATION_DIAGNOSTICS_MAX_BYTES:-5000000}"
  python3 - "$DIAGNOSTICS_DIR" "$cap" <<'PY'
import os
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
cap = int(sys.argv[2])
files = sorted((path for path in root.rglob("*") if path.is_file()), key=lambda path: (path.name == "result.txt", str(path)))
total = sum(path.stat().st_size for path in files)
for path in files:
    if total <= cap or path.name == "result.txt":
        continue
    size = path.stat().st_size
    keep = max(0, min(size, cap - (total - size)))
    if keep == 0:
        path.unlink()
    elif keep < size:
        data = path.read_bytes()
        path.write_bytes(data[:keep // 2] + b"\n...[diagnostics truncated by cap]\n" + data[-(keep // 2):])
    total = sum(candidate.stat().st_size for candidate in root.rglob("*") if candidate.is_file())
PY
}

collect_diagnostics() {
  mkdir -p "$DIAGNOSTICS_DIR"
  for name in setup.out runtime.out runtime.err opencode-auth-list.out opencode-auth-list.err runtime-auth-list.out runtime-auth-list.err daily-mutation.out daily-fanout.out fanout-before.txt fanout-after.txt fanout-new.txt fanout-messages.jsonl sessions-after-fanout.json real-response-copy.txt benchmark-blocker.txt benchmark-compare.out benchmark-validate.out daily-report.json; do
    copy_bounded "$TEST_ROOT/$name" "$DIAGNOSTICS_DIR/$name"
  done
  for name in OPENCODE_AUTH REAL_DAILY_RESPONSE_COPY REAL_4_CHILD_PARALLEL parent-session-id child-session-id opencode-auth-metadata.json codex-auth-metadata.json opencode-destination-metadata.json packet-schema.json; do
    copy_bounded "$TEST_ROOT/$name" "$DIAGNOSTICS_DIR/$name" 50000
  done
  if [ -n "$RUN_STATE_DIR" ] && [ -d "$RUN_STATE_DIR" ]; then
    for name in manifest.json state port parent_session_id launcher.identity server.identity bridge.identity watchdog.identity reaper.identity bridge.log reaper.log; do
      copy_bounded "$RUN_STATE_DIR/$name" "$DIAGNOSTICS_DIR/run-state/$name"
    done
  fi
  if [ -d "$TEAM_HOME/cache/runtime" ]; then
    find "$TEAM_HOME/cache/runtime" -maxdepth 5 -name manifest.json -type f -print | while IFS= read -r manifest; do
      copy_bounded "$manifest" "$DIAGNOSTICS_DIR/manifests/$(basename "$(dirname "$manifest")").json" 50000
    done
  fi
  OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEP_ROOT" "$ROOT/bin/opencode-team" runtime-status >"$DIAGNOSTICS_DIR/runtime-status.json" 2>"$DIAGNOSTICS_DIR/runtime-status.err" || true
  printf 'result=failed\nsource_root_deleted=true\n' >"$DIAGNOSTICS_DIR/result.txt"
  cap_diagnostics
}

cleanup() {
  local exit_code=$?
  [ "$exit_code" -eq 0 ] || FAILED=1
  cd "$ROOT" 2>/dev/null || cd /tmp 2>/dev/null || true
  if [ -n "$PREFLIGHT_PID" ]; then
    kill "$PREFLIGHT_PID" >/dev/null 2>&1 || true
  fi
  for pid in "$RUNTIME_PID" "$BRIDGE_PID" "$WATCHDOG_PID" "$REAPER_PID" "$SERVER_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  if [ -n "$RUNTIME_SESSION" ]; then
    tmux kill-session -t "$RUNTIME_SESSION" >/dev/null 2>&1 || true
  fi
  if [ -n "$RUNTIME_PID" ]; then
    kill "$RUNTIME_PID" >/dev/null 2>&1 || true
  fi
  if [ "$FAILED" = 1 ] || [ "$PRESERVE_TEST_ROOT" = 1 ]; then
    collect_diagnostics
    printf 'certification_diagnostics_dir=%s\n' "$DIAGNOSTICS_DIR" >&2
  else
    rm -rf "$DIAGNOSTICS_DIR"
  fi
  rm -rf "$TEAM_HOME" "$TEST_ROOT"
  return "$exit_code"
}
trap cleanup EXIT INT TERM

block() {
  printf 'CERTIFICATION BLOCKED: %s\n' "$*" >&2
  FAILED=1
  exit 1
}

if [ "${OPENAI_DAILY_CERTIFICATION_INTENTIONAL_FAILURE:-}" = 1 ]; then
  block "intentional failure probe"
  printf '%s\n' 'OPENAI DAILY CERTIFICATION PASS'
  exit 0
fi

assert_file() {
  [ -f "$1" ] || block "missing file: $1"
}

assert_nonempty() {
  [ -s "$1" ] || block "empty file: $1"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || block "missing command: $1"
}

run_with_timeout() {
  local seconds="$1" output="$2"
  shift 2
  "$@" >"$output" 2>&1 &
  local pid=$!
  PREFLIGHT_PID="$pid"
  (
    sleep "$seconds"
    kill "$pid" >/dev/null 2>&1 || true
  ) &
  local timer=$!
  local rc=0
  wait "$pid" || rc=$?
  PREFLIGHT_PID=""
  kill "$timer" >/dev/null 2>&1 || true
  wait "$timer" >/dev/null 2>&1 || true
  return "$rc"
}

post_session_message() {
  local output="$1" prompt="$2" body before_count status count
  body="$(jq -n --arg text "$prompt" '{agent:"openai_orchestrator",parts:[{type:"text",text:$text}]}')"
  before_count="$(curl -fsS --max-time 10 "http://127.0.0.1:$port/session/$parent_session/message" | jq 'length')"
  run_with_timeout 20 "$output" curl -fsS --max-time 15 -X POST "http://127.0.0.1:$port/session/$parent_session/prompt_async" \
    -H 'Content-Type: application/json' --data "$body" >/dev/null || return 1
  for _ in $(seq 1 300); do
    status="$(curl -fsS --max-time 10 "http://127.0.0.1:$port/session/status" | jq -r --arg id "$parent_session" '.[$id].type // "unknown"')" || return 1
    count="$(curl -fsS --max-time 10 "http://127.0.0.1:$port/session/$parent_session/message" | jq 'length')" || return 1
    if [ "$count" -gt "$before_count" ] && [ "$status" != busy ] && [ "$status" != retry ]; then
      curl -fsS --max-time 10 "http://127.0.0.1:$port/session/$parent_session/message" >"$output"
      if jq -e 'any(.[]; .info.role == "assistant")' "$output" >/dev/null 2>&1; then
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

discover_opencode_auth_source() {
  local out="$TEST_ROOT/opencode-auth-list.out" err="$TEST_ROOT/opencode-auth-list.err"
  if ! env \
    -u OPENCODE \
    -u OPENCODE_CONFIG \
    -u OPENCODE_CONFIG_DIR \
    -u OPENCODE_PID \
    -u OPENCODE_SERVER_URL \
    -u OMO_PROFILE \
    -u XDG_CACHE_HOME \
    -u XDG_CONFIG_HOME \
    -u XDG_DATA_HOME \
    -u XDG_STATE_HOME \
    opencode auth list --pure >"$out" 2>"$err"; then
    block "opencode auth list failed before metadata discovery; see $err"
  fi
  node - "$out" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const text = fs.readFileSync(process.argv[2], "utf8");
const paths = new Set();
const clean = text.replace(/\u001b\[[0-9;]*m/g, "");
const credentialsLines = clean.split(/\r?\n/).filter((line) => line.includes("Credentials"));
if (credentialsLines.length === 1) {
  const candidate = credentialsLines[0].trim().split(/\s+/).at(-1);
  paths.add(candidate.startsWith("~/") ? path.join(process.env.HOME, candidate.slice(2)) : candidate);
}
for (const match of text.matchAll(/(?:^|[\s("'=])((?:\/[^\s"'<>]+)+\/opencode\/auth\.json)(?=$|[\s)"',])/g)) {
  paths.add(match[1]);
}
if (paths.size !== 1) process.exit(1);
process.stdout.write(`${[...paths][0]}\n`);
NODE
}

validate_auth_metadata() {
  local path="$1" label="$2"
  node - "$path" "$label" <<'NODE'
const fs = require("node:fs");
const [path, label] = process.argv.slice(2);
const fail = (reason) => {
  console.error(`${label} auth metadata refused: ${reason}`);
  process.exit(1);
};
let info;
try {
  info = fs.lstatSync(path);
} catch {
  fail("missing");
}
if (info.isSymbolicLink()) fail("symlink");
if (!info.isFile()) fail("not_regular");
if (typeof process.getuid === "function" && info.uid !== process.getuid()) fail("owner");
if (info.nlink !== 1) fail("link_count");
if ((info.mode & 0o777) !== 0o600) fail("mode");
process.stdout.write(JSON.stringify({ label, mode: "0600", uid: info.uid, nlink: info.nlink, size: info.size }) + "\n");
NODE
}

bridge_auth_file() {
  local source="$1" destination="$2" root="$3" label="$4"
  node - "$source" "$destination" "$root" "$label" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const [source, destination, root, label] = process.argv.slice(2);
const fail = (reason) => {
  console.error(`${label} auth bridge refused: ${reason}`);
  process.exit(1);
};
const validate = (file, name) => {
  let info;
  try {
    info = fs.lstatSync(file);
  } catch {
    fail(`${name}_missing`);
  }
  if (info.isSymbolicLink()) fail(`${name}_symlink`);
  if (!info.isFile()) fail(`${name}_not_regular`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) fail(`${name}_owner`);
  if (info.nlink !== 1) fail(`${name}_link_count`);
  if ((info.mode & 0o777) !== 0o600) fail(`${name}_mode`);
};
validate(source, "source");
fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
const realRoot = fs.realpathSync(root);
const realParent = fs.realpathSync(path.dirname(destination));
if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${path.sep}`)) fail("destination_root");
const temporary = path.join(path.dirname(destination), `.auth.${process.pid}.${crypto.randomUUID()}`);
try {
  fs.copyFileSync(source, temporary);
  fs.chmodSync(temporary, 0o600);
  validate(temporary, "temporary");
  fs.renameSync(temporary, destination);
  validate(destination, "destination");
} finally {
  try {
    fs.rmSync(temporary, { force: true });
  } catch {}
}
NODE
}

wait_for_runtime_state() {
  local run_root="$TEAM_HOME/cache/runtime/daily/runs" run_dir count
  for _ in $(seq 1 90); do
    if [ -d "$run_root" ]; then
      count="$(find "$run_root" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
      if [ "$count" = 1 ]; then
        run_dir="$(find "$run_root" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
        [ -f "$run_dir/port" ] && [ -f "$run_dir/server.pid" ] && [ -f "$run_dir/parent_session_id" ] && [ -f "$run_dir/bridge.identity" ] && {
          printf '%s\n' "$run_dir"
          return 0
        }
      fi
    fi
    sleep 1
  done
  return 1
}

for command_name in opencode codex node npm jq curl tmux python3 rg; do
  require_command "$command_name"
done

probe_output="$TEST_ROOT/intentional-failure.out"
if OPENAI_DAILY_CERTIFICATION_INTENTIONAL_FAILURE=1 "$0" >"$probe_output" 2>&1; then
  block "intentional failure returned zero"
fi
if rg -q 'OPENAI DAILY CERTIFICATION PASS' "$probe_output"; then
  block "intentional failure printed PASS"
fi
if rg -q 'certification_evidence_root=' "$probe_output"; then
  block "intentional failure preserved full root"
fi
probe_diag="$(sed -n 's/^certification_diagnostics_dir=//p' "$probe_output" | tail -n 1)"
[ -n "$probe_diag" ] || block "intentional failure did not emit diagnostics dir"
[ -d "$probe_diag" ] || block "intentional failure diagnostics dir missing"
[ ! -d "$probe_diag/team-home" ] || block "intentional failure diagnostics included heavy team home"
assert_file "$probe_diag/result.txt"
rg -q 'source_root_deleted=true' "$probe_diag/result.txt" || block "intentional failure did not record source cleanup"
probe_diag_bytes="$(du -sk "$probe_diag" | awk '{print $1 * 1024}')"
[ "$probe_diag_bytes" -le "${OPENAI_DAILY_CERTIFICATION_DIAGNOSTICS_MAX_BYTES:-5000000}" ] || block "intentional failure diagnostics exceeded cap"
rm -rf "$probe_diag"

opencode_auth_source="$(discover_opencode_auth_source)" || block "opencode auth metadata did not include exactly one auth.json path"
validate_auth_metadata "$opencode_auth_source" "OpenCode source" >"$TEST_ROOT/opencode-auth-metadata.json"
codex_auth_source="${OPENAI_DAILY_CERTIFICATION_CODEX_AUTH_SOURCE:-$HOME/.codex/auth.json}"
validate_auth_metadata "$codex_auth_source" "Codex source" >"$TEST_ROOT/codex-auth-metadata.json"

OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEP_ROOT" "$ROOT/bin/opencode-team" setup >"$TEST_ROOT/setup.out"
assert_file "$TEAM_HOME/config/daily/opencode.jsonc"
node - "$TEAM_HOME/config/daily/opencode.jsonc" <<'NODE'
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (config.default_agent !== "openai_orchestrator") fail("daily default agent mismatch");
if (!Array.isArray(config.enabled_providers) || config.enabled_providers.join(",") !== "openai") fail("daily provider policy mismatch");
if (!Array.isArray(config.plugin) || !config.plugin.some((plugin) => plugin.endsWith("/teams/openai/config/opencode/openai-team-tools.js"))) fail("daily tool plugin missing");
if (config.model !== "openai/gpt-5.6-luna" || config.small_model !== "openai/gpt-5.6-luna") fail("daily model mismatch");
NODE

fixture="$TEST_ROOT/fixture"
mkdir -p "$fixture"
printf '%s\n' 'function add(a, b) { return a + b; }' 'module.exports = { add };' >"$fixture/calculator.js"
printf '%s\n' "const { add } = require('./calculator.js');" 'if (add(2, 3) !== 5) throw new Error("add failed");' 'console.log("calculator tests passed");' >"$fixture/calculator.test.js"
node "$fixture/calculator.test.js" >"$TEST_ROOT/fixture-baseline.out"

cd "$fixture"
TEAM_RUNTIME_HEADLESS=1 OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEP_ROOT" OPENCODE_AUTH_SOURCE="$opencode_auth_source" \
  OPENAI_CODEX_AUTH_SOURCE="$codex_auth_source" "$ROOT/bin/opencode-team" daily >"$TEST_ROOT/runtime.out" 2>"$TEST_ROOT/runtime.err" &
RUNTIME_PID=$!
run_dir="$(wait_for_runtime_state)" || block "daily runtime did not publish bounded run state"
RUN_STATE_DIR="$run_dir"
server_pid="$(< "$run_dir/server.pid")"
SERVER_PID="$server_pid"
BRIDGE_PID="$(< "$run_dir/bridge.pid")"
[ -f "$run_dir/watchdog.pid" ] && WATCHDOG_PID="$(< "$run_dir/watchdog.pid")"
[ -f "$run_dir/reaper.pid" ] && REAPER_PID="$(< "$run_dir/reaper.pid")"
port="$(< "$run_dir/port")"
parent_session="$(< "$run_dir/parent_session_id")"
[ -n "$parent_session" ] || block "daily parent session was not created"
kill -0 "$server_pid" >/dev/null 2>&1 || block "daily server pid is not alive"
curl -fsS --max-time 5 "http://127.0.0.1:$port/" >/dev/null || block "daily server API not ready"
assert_file "$run_dir/server.identity"
assert_file "$run_dir/bridge.identity"
validate_auth_metadata "$TEAM_HOME/data/daily/data/opencode/auth.json" "OpenCode destination" >"$TEST_ROOT/opencode-destination-metadata.json"
runtime_auth_output="$TEST_ROOT/runtime-auth-list.out"
XDG_DATA_HOME="$TEAM_HOME/data/daily/data" XDG_CONFIG_HOME="$TEAM_HOME/config/daily/xdg-config" \
  OPENCODE_CONFIG="$TEAM_HOME/config/daily/opencode.jsonc" OPENCODE_CONFIG_DIR="$TEAM_HOME/config/daily" \
  OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_DISABLE_CLAUDE_CODE=1 opencode auth list >"$runtime_auth_output" 2>"$TEST_ROOT/runtime-auth-list.err"
rg -q 'OpenAI' "$runtime_auth_output" || block "OpenCode provider preflight failed"
printf '%s\n' PASS >"$TEST_ROOT/OPENCODE_AUTH"

mutation_prompt='Inspect this fixture first using the appropriate repository worker. The orchestrator MUST delegate the implementation to codex_executor, codex_executor MUST edit only calculator.js and calculator.test.js, and the tester MUST execute node calculator.test.js before completion. Add multiply(a, b) to calculator.js, add a focused test, execute the test, and give a concise final summary. Do not only describe edits: make the files change. Work only inside this fixture.'
request_output="$TEST_ROOT/daily-mutation.out"
if ! post_session_message "$request_output" "$mutation_prompt"; then
  block "real Daily parent request failed; see $request_output"
fi
assert_file "$fixture/calculator.js"
assert_file "$fixture/calculator.test.js"
rg -q 'multiply' "$fixture/calculator.js" || block "Daily did not add multiply"
rg -q 'multiply' "$fixture/calculator.test.js" || block "Daily did not add multiply test"
node "$fixture/calculator.test.js" >"$TEST_ROOT/daily-mutation-verification.out"

curl -fsS --max-time 5 "http://127.0.0.1:$port/session" >"$TEST_ROOT/sessions-after-mutation.json"
child_ids="$TEST_ROOT/mutation-child-ids.txt"
jq -er --arg parent "$parent_session" '[.[] | select(.parentID == $parent)] | if length > 0 then .[] | .id else error("no child") end' \
  "$TEST_ROOT/sessions-after-mutation.json" >"$child_ids" || block "real Daily child session was not persisted"
child_session="$(while IFS= read -r id; do printf '%s' "$id"; break; done <"$child_ids")"
[ "$(wc -l <"$child_ids" | tr -d ' ')" -ge 1 ] || block "real Daily child session count is zero"
jq -e --arg child "$child_session" --arg parent "$parent_session" '.[] | select(.id == $child and .parentID == $parent)' \
  "$TEST_ROOT/sessions-after-mutation.json" >"$TEST_ROOT/child-relationship.json" || block "child parentID relationship invalid"
printf '%s\n' "$parent_session" >"$TEST_ROOT/parent-session-id"
printf '%s\n' "$child_session" >"$TEST_ROOT/child-session-id"

for session_id in "$parent_session" "$child_session"; do
  curl -fsS --max-time 5 "http://127.0.0.1:$port/session/$session_id/message" >"$TEST_ROOT/messages-$session_id.json"
done
rg -qi 'calculator\.test\.js|node .*calculator' "$TEST_ROOT/messages-"* || block "persisted messages do not prove test command"

NODE_ROOT="$ROOT" NODE_SERVER="http://127.0.0.1:$port" NODE_PARENT="$parent_session" NODE_COPY="$TEST_ROOT/real-response-copy.txt" node <<'NODE'
const fs = await import("node:fs");
const { pathToFileURL } = await import("node:url");
const { copyResponse } = await import(pathToFileURL(`${process.env.NODE_ROOT}/shared/response-copy/response-copy-plugin.js`));
const base = process.env.NODE_SERVER;
const get = async (path) => ({ data: await (await fetch(`${base}${path}`)).json() });
let copied = "";
const api = {
  route: { current: { name: "session", params: { sessionID: process.env.NODE_PARENT } } },
  client: { session: {
    get: ({ sessionID }) => get(`/session/${sessionID}`),
    messages: ({ sessionID }) => get(`/session/${sessionID}/message`),
    status: () => get("/session/status"),
  } },
  renderer: { copyToClipboardOSC52: async (value) => { copied = value; } },
  ui: { toast: () => {} },
};
await copyResponse(api);
if (!copied) process.exit(1);
fs.writeFileSync(process.env.NODE_COPY, copied, { mode: 0o600 });
NODE
for required in 'ORCHESTRATOR' 'SUBAGENT' 'calculator.js' 'calculator.test.js' 'node' 'FINAL RESPONSE'; do
  rg -qi "$required" "$TEST_ROOT/real-response-copy.txt" || block "real response-copy missing: $required"
done
printf '%s\n' PASS >"$TEST_ROOT/REAL_DAILY_RESPONSE_COPY"

packet_root="$TEAM_HOME/data/daily/state/team/work-packets"
assert_file "$(find "$packet_root" -maxdepth 1 -type f -name '*.json' -print -quit)"
node - "$packet_root" "$TEST_ROOT/packet-schema.json" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [root, output] = process.argv.slice(2);
const files = fs.readdirSync(root).filter((name) => name.endsWith(".json"));
const packets = files.flatMap((name) => { try { return [JSON.parse(fs.readFileSync(path.join(root, name)))]; } catch { return []; } });
if (!packets.length) process.exit(1);
const fields = ["codex_input_tokens", "codex_cached_input_tokens", "codex_output_tokens", "codex_reasoning_tokens", "opencode_input_tokens", "opencode_cached_input_tokens", "opencode_output_tokens", "opencode_reasoning_tokens", "executed_model", "requested_model", "duration_ms", "retry_count", "compaction_count", "complexity", "parent_session_id"];
const result = Object.fromEntries(fields.map((field) => [field, packets.some((packet) => Object.hasOwn(packet, field))]));
fs.writeFileSync(output, JSON.stringify({ packet_count: packets.length, fields: result }, null, 2), { mode: 0o600 });
NODE
report_output="$TEST_ROOT/daily-report.json"
OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEP_ROOT" "$ROOT/bin/opencode-team" daily-report >"$report_output"
jq -e '.completed_tasks >= 1' "$report_output" >/dev/null || block "daily-report did not see real work packets"

curl -fsS --max-time 5 "http://127.0.0.1:$port/session" >"$TEST_ROOT/sessions-before-fanout.json"
jq -er --arg parent "$parent_session" '.[] | select(.parentID == $parent) | .id' "$TEST_ROOT/sessions-before-fanout.json" | sort -u >"$TEST_ROOT/fanout-before.txt"
fanout_prompt='This is a hard acceptance gate. Before replying, use the orchestrator delegation tool to create exactly FOUR child sessions in parallel, one and only one for each distinct slice: architecture, tests, runtime, documentation. Include the exact slice name in each child prompt. Wait for all four child results, then summarize them. Do not perform the analysis yourself, do not skip delegation, and do not edit any file.'
fanout_output="$TEST_ROOT/daily-fanout.out"
fanout_start="$(python3 -c 'import time; print(int(time.time() * 1000))')"
for fanout_attempt in 1 2 3; do
  if [ "$fanout_attempt" -gt 1 ]; then
    fanout_prompt="The prior delegation was incomplete. Create only the missing repository-worker child slices now: architecture, tests, runtime, documentation. Use one child per missing slice, do not duplicate existing children, wait for them, and do not edit files. This is required before replying."
  fi
  post_session_message "$fanout_output" "$fanout_prompt" || block "real Daily four-slice request failed; see $fanout_output"
  curl -fsS --max-time 5 "http://127.0.0.1:$port/session" >"$TEST_ROOT/sessions-after-fanout.json"
  jq -er --arg parent "$parent_session" '.[] | select(.parentID == $parent) | .id' "$TEST_ROOT/sessions-after-fanout.json" | sort -u >"$TEST_ROOT/fanout-after.txt"
  comm -13 "$TEST_ROOT/fanout-before.txt" "$TEST_ROOT/fanout-after.txt" >"$TEST_ROOT/fanout-new.txt"
  fanout_count="$(wc -l <"$TEST_ROOT/fanout-new.txt" | tr -d ' ')"
  [ "$fanout_count" -eq 4 ] && break
  [ "$fanout_count" -lt 4 ] || block "real four-slice fanout created too many children"
done
fanout_end="$(python3 -c 'import time; print(int(time.time() * 1000))')"
[ "$(wc -l <"$TEST_ROOT/fanout-new.txt" | tr -d ' ')" -eq 4 ] || block "real four-slice fanout did not create exactly four new children"
for slice in architecture tests runtime documentation; do
  found=0
  while IFS= read -r session_id; do
    curl -fsS --max-time 5 "http://127.0.0.1:$port/session/$session_id/message" >>"$TEST_ROOT/fanout-messages.jsonl"
  done <"$TEST_ROOT/fanout-new.txt"
  rg -qi "$slice" "$TEST_ROOT/fanout-messages.jsonl" && found=1
  [ "$found" -eq 1 ] || block "fanout slice evidence missing: $slice"
done
NODE_SESSIONS="$TEST_ROOT/sessions-after-fanout.json" NODE_CHILDREN="$TEST_ROOT/fanout-new.txt" NODE_START="$fanout_start" NODE_END="$fanout_end" node <<'NODE'
const fs = require("node:fs");
const sessions = JSON.parse(fs.readFileSync(process.env.NODE_SESSIONS, "utf8"));
const ids = fs.readFileSync(process.env.NODE_CHILDREN, "utf8").trim().split(/\s+/).filter(Boolean);
const start = Number(process.env.NODE_START), end = Number(process.env.NODE_END);
const interval = (session) => {
  const time = session.time ?? {};
  const created = Number(time.created), updated = Number(time.updated);
  return Number.isFinite(created) && Number.isFinite(updated) ? [created, updated] : null;
};
const children = ids.map((id) => sessions.find((session) => session.id === id)).filter(Boolean);
if (children.length !== 4 || !children.every((session) => session.parentID)) process.exit(1);
if (!children.every((session) => { const value = interval(session); return value && value[0] >= start && value[0] <= end; })) process.exit(1);
let overlap = false;
for (const left of children) for (const right of children) if (left !== right) {
  const a = interval(left), b = interval(right);
  if (Math.max(a[0], b[0]) <= Math.min(a[1], b[1])) overlap = true;
}
if (!overlap) process.exit(1);
NODE
printf '%s\n' PASS >"$TEST_ROOT/REAL_4_CHILD_PARALLEL"

manifest="$ROOT/tests/fixtures/openai-daily-benchmark.json"
assignments="$TEST_ROOT/openai-daily-assignments.jsonl"
node "$ROOT/teams/openai/bin/openai-benchmark.mjs" validate "$manifest" >"$TEST_ROOT/benchmark-validate.out"
node "$ROOT/teams/openai/bin/openai-benchmark.mjs" assign "$manifest" openai-daily-cert \
  --model openai-daily \
  --model-version 1.18.31 \
  --reasoning-effort low \
  --config-fingerprint "$(shasum -a 256 "$TEAM_HOME/config/daily/opencode.jsonc" | cut -d' ' -f1)" \
  --prompt-policy-version daily-profile \
  --code-revision "$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || printf 'unknown')" \
  --environment-fingerprint local-cert \
  --timestamp "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  >"$assignments"
assert_nonempty "$assignments"

if [ -z "${OPENAI_DAILY_BENCHMARK_RESULTS:-}" ]; then
  printf 'benchmark_blocked=missing_OPENAI_DAILY_BENCHMARK_RESULTS\nassignments=%s\n' "$assignments" >"$TEST_ROOT/benchmark-blocker.txt"
  block "profile-vs-profile benchmark evidence unavailable; assignments persisted at $assignments"
fi
assert_file "$OPENAI_DAILY_BENCHMARK_RESULTS"
compare_output="$TEST_ROOT/benchmark-compare.out"
node "$ROOT/teams/openai/bin/openai-benchmark.mjs" compare "$OPENAI_DAILY_BENCHMARK_RESULTS" >"$compare_output"
node - "$compare_output" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/, 1)[0]);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (report.schema_version !== 1) fail("benchmark schema mismatch");
if (!report.overall?.control?.count || !report.overall?.treatment?.count) fail("benchmark missing profile pair");
if (report.decision !== "accept") fail(`benchmark did not accept treatment: ${report.decision}`);
NODE

printf '%s\n' 'OPENAI DAILY CERTIFICATION PASS'
