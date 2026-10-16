#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENCODE_TEAM_PACKAGE_ROOT:-$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DEPENDENCY_ROOT="${OPENCODE_TEAM_DEPENDENCY_ROOT:-$HOME/.local/share/opencode-team/dependencies}"
FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/deep-audit-tmux-runtime.XXXXXX")"
FIXTURE="$(cd -P "$FIXTURE" && pwd -P)"
TEAM_HOME="$FIXTURE/deep audit profile"
TMUX_TMPDIR="$(mktemp -d "/tmp/da-tmux.XXXXXX")"
TARGET="$FIXTURE/project with spaces"
OTHER_TARGET="$FIXTURE/other project with spaces"
TMUX_PREFIX=oc-deep-audit
if [ -n "${OPENCODE_TEAM_HOME:-}" ]; then
  SOURCE_ECC="$OPENCODE_TEAM_HOME/data/deep-audit/ecc"
else
  SOURCE_ECC="$HOME/.local/share/opencode-team/deep-audit/ecc"
fi
runtime_pid=""
active_session=""

tmux_cmd() { env -u TMUX TMUX_TMPDIR="$TMUX_TMPDIR" tmux "$@"; }

cleanup() {
  local rc=$?
  if [ -n "${active_session:-}" ]; then tmux_cmd kill-session -t "$active_session" >/dev/null 2>&1 || true; fi
  if [ -n "${runtime_pid:-}" ] && kill -0 "$runtime_pid" 2>/dev/null; then
    kill -TERM "$runtime_pid" 2>/dev/null || true
    wait "$runtime_pid" 2>/dev/null || true
  fi
  tmux_cmd kill-server >/dev/null 2>&1 || true
  rm -rf "$TMUX_TMPDIR" "$FIXTURE"
  return "$rc"
}
trap cleanup EXIT INT TERM

mkdir -p "$TARGET" "$OTHER_TARGET"
chmod 700 "$TMUX_TMPDIR"
cp "$ROOT/tests/fixtures/deep-audit-test-runner/javascript/package.json" \
  "$ROOT/tests/fixtures/deep-audit-test-runner/javascript/calculator.js" \
  "$ROOT/tests/fixtures/deep-audit-test-runner/javascript/calculator.test.js" "$TARGET/"
printf '%s\n' 'different project used only for the mismatched-resume check' >"$OTHER_TARGET/README.md"

tree_hash() {
  node - "$1" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = process.argv[2];
const hash = crypto.createHash("sha256");
function walk(dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const relative = path.relative(root, file);
    const info = fs.lstatSync(file);
    hash.update(relative).update("\0");
    if (info.isDirectory()) walk(file);
    else if (info.isFile()) hash.update(fs.readFileSync(file));
    else if (info.isSymbolicLink()) hash.update(fs.readlinkSync(file));
    hash.update("\0");
  }
}
walk(root);
process.stdout.write(`${hash.digest("hex")}\n`);
NODE
}

target_before="$(tree_hash "$TARGET")"
target_real="$(cd -P "$TARGET" && pwd -P)"
other_target_real="$(cd -P "$OTHER_TARGET" && pwd -P)"

if env -u DEEP_AUDIT_TARGET_ROOT -u DEEP_AUDIT_REPORT_ROOT \
  OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEPENDENCY_ROOT" \
  "$ROOT/bin/opencode-team" deep-audit "$FIXTURE/missing project" >"$FIXTURE/missing-target.log" 2>&1; then
  printf 'Deep Audit accepted a nonexistent target\n' >&2
  exit 1
fi
rg -q 'target is not a directory' "$FIXTURE/missing-target.log"

# Reuse the already-verified pinned checkout to keep this runtime test
# offline; never copy OAuth/session state into the disposable profile.
test -d "$SOURCE_ECC/.git" || { printf 'Pinned Deep Audit ECC fixture source is unavailable: %s\n' "$SOURCE_ECC" >&2; exit 1; }
mkdir -p "$TEAM_HOME/data/deep-audit"
cp -R "$SOURCE_ECC" "$TEAM_HOME/data/deep-audit/ecc"
if env -u OPENCODE_BIN OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEPENDENCY_ROOT" \
  "$ROOT/bin/opencode-team" deep-audit-setup >"$FIXTURE/setup.log" 2>&1; then
  :
else
  cat "$FIXTURE/setup.log" >&2
  exit 1
fi
TEAM_HOME="$(cd -P "$TEAM_HOME" && pwd -P)"
test ! -f "$TEAM_HOME/data/deep-audit/data/opencode/auth.json"

# Exercise core failure/manifest cleanup with both audit variables absent.
if env -u DEEP_AUDIT_TARGET_ROOT -u DEEP_AUDIT_REPORT_ROOT \
  TEAM_RUNTIME_INNER=1 TMUX=core-target-guard SESSION_MODE=new RESUME_SESSION_ID= RUN_ID=da11fa11 \
  OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEPENDENCY_ROOT" \
  bash "$ROOT/core/bin/team-runtime" --config "$TEAM_HOME/config/deep-audit/team-runtime.conf" \
  >"$FIXTURE/core-missing-target.log" 2>&1; then
  printf 'Deep Audit core accepted a missing target\n' >&2
  exit 1
else
  core_rc=$?
fi
test "$core_rc" -eq 1
rg -q 'ERROR: Deep Audit target directory is required' "$FIXTURE/core-missing-target.log"
if rg -q 'Abort trap: 6' "$FIXTURE/core-missing-target.log"; then
  printf '%s\n' 'missing-target failure caused an Abort trap 6' >&2
  cat "$FIXTURE/core-missing-target.log" >&2
  exit 1
fi
failed_run=""
for candidate in "$TEAM_HOME/cache/runtime/deep-audit/runs/"*; do
  [ -d "$candidate" ] || continue
  if [ "$(cat "$candidate/failure_reason" 2>/dev/null || true)" = 'Deep Audit target directory is required' ]; then failed_run="$candidate"; break; fi
done
test -n "$failed_run"
jq -e '.status == "FAILED" and .failure_reason == "Deep Audit target directory is required"' "$failed_run/manifest.json" >/dev/null
test ! -f "$failed_run/server.pid"
rm -rf "$failed_run"

# Pre-create a real server with stale global values. Each Deep Audit session
# must get explicit target/report values and its own starting directory.
tmux_cmd new-session -d -s stale-environment 'sleep 600'
tmux_cmd set-environment -g DEEP_AUDIT_TARGET_ROOT "$FIXTURE/stale target from tmux server"
tmux_cmd set-environment -g DEEP_AUDIT_REPORT_ROOT "$FIXTURE/stale report from tmux server"

# Simulate the original propagation failure at the actual tmux boundary: the
# client has no target, while the already-running server has stale global vars.
missing_tmux_log="$FIXTURE/core-missing-tmux-env.log"
env -u SHELL -u TMUX -u DEEP_AUDIT_TARGET_ROOT -u DEEP_AUDIT_REPORT_ROOT -u TEAM_RUNTIME_INNER \
  TMUX_TMPDIR="$TMUX_TMPDIR" OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEPENDENCY_ROOT" \
  bash "$ROOT/core/bin/team-runtime" --config "$TEAM_HOME/config/deep-audit/team-runtime.conf" \
  >"$missing_tmux_log" 2>&1 &
runtime_pid=$!
wait "$runtime_pid" 2>/dev/null || true
runtime_pid=""
missing_tmux_session="$(rg 'Starting tmux session:' "$missing_tmux_log" | awk '{print $4}' | head -n 1)"
[ -n "$missing_tmux_session" ] || { cat "$missing_tmux_log" >&2; printf '%s\n' 'missing-target tmux session was not created' >&2; exit 1; }
test "$(tmux_cmd show-environment -t "$missing_tmux_session" DEEP_AUDIT_TARGET_ROOT)" = 'DEEP_AUDIT_TARGET_ROOT='
test "$(tmux_cmd show-environment -t "$missing_tmux_session" DEEP_AUDIT_REPORT_ROOT)" = 'DEEP_AUDIT_REPORT_ROOT='
missing_tmux_run_id="${missing_tmux_session##*-}"
missing_tmux_run="$TEAM_HOME/cache/runtime/deep-audit/runs/$missing_tmux_run_id"
for _ in $(seq 1 30); do [ -f "$missing_tmux_run/manifest.json" ] && break; sleep 0.2; done
jq -e '.status == "FAILED" and .failure_reason == "Deep Audit target directory is required"' "$missing_tmux_run/manifest.json" >/dev/null
missing_tmux_pane="$(tmux_cmd capture-pane -p -t "$missing_tmux_session:0.0")"
printf '%s' "$missing_tmux_pane" | rg -q 'ERROR: Deep Audit target directory is required'
if printf '%s' "$missing_tmux_pane" | rg -q 'Abort trap: 6'; then
  printf '%s\n' 'missing-target tmux failure caused an Abort trap 6' >&2
  exit 1
fi
tmux_cmd kill-session -t "$missing_tmux_session" >/dev/null 2>&1 || true
rm -rf "$missing_tmux_run"

start_audit() {
  local log="$1"
  shift
  env -u SHELL -u TMUX -u TEAM_RUNTIME_HEADLESS -u DEEP_AUDIT_TARGET_ROOT -u DEEP_AUDIT_REPORT_ROOT \
    TMUX_TMPDIR="$TMUX_TMPDIR" TERM=xterm-256color \
    OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEPENDENCY_ROOT" \
    "$ROOT/bin/opencode-team" deep-audit "$@" >"$log" 2>&1 &
  runtime_pid=$!
}

wait_for_active_run() {
  local readiness run
  for _ in $(seq 1 90); do
    readiness="$(TMUX_TMPDIR="$TMUX_TMPDIR" OPENCODE_TEAM_HOME="$TEAM_HOME" \
      OPENCODE_TEAM_DEPENDENCY_ROOT="$DEPENDENCY_ROOT" "$ROOT/bin/opencode-team" runtime-readiness 2>/dev/null || true)"
    run="$(printf '%s' "$readiness" | jq -r '[.runs[] | select(.ready == true and (.run | startswith("deep-audit/")))][0].run // empty' 2>/dev/null || true)"
    if [ -n "$run" ]; then
      RUN_REL="$run"
      RUN_DIR="$TEAM_HOME/cache/runtime/$RUN_REL"
      RUN_ID="${RUN_REL##*/}"
      SESSION_NAME="$TMUX_PREFIX-$RUN_ID"
      active_session="$SESSION_NAME"
      for _ in $(seq 1 30); do
        if [ -f "$RUN_DIR/attach.pid" ] && kill -0 "$(cat "$RUN_DIR/attach.pid")" 2>/dev/null; then return 0; fi
        sleep 0.2
      done
      return 1
    fi
    sleep 1
  done
  printf 'runtime readiness did not become active: %s\n' "${readiness:-unavailable}" >&2
  tmux_cmd list-sessions >&2 || true
  while IFS= read -r session; do
    case "$session" in
      "$TMUX_PREFIX-"*) tmux_cmd capture-pane -p -t "$session:0.0" >&2 || true ;;
    esac
  done < <(tmux_cmd list-sessions -F '#{session_name}' 2>/dev/null || true)
  return 1
}

assert_active_context() {
  local expected_target="$1" target_env report_env pane_dir attach_pid manifest
  target_env="$(tmux_cmd show-environment -t "$SESSION_NAME" DEEP_AUDIT_TARGET_ROOT)"
  report_env="$(tmux_cmd show-environment -t "$SESSION_NAME" DEEP_AUDIT_REPORT_ROOT)"
  test "$target_env" = "DEEP_AUDIT_TARGET_ROOT=$expected_target"
  test "$report_env" = "DEEP_AUDIT_REPORT_ROOT=$TEAM_HOME/data/deep-audit/reports"
  test "$(tmux_cmd show-environment -g DEEP_AUDIT_TARGET_ROOT)" = "DEEP_AUDIT_TARGET_ROOT=$FIXTURE/stale target from tmux server"
  test "$(tmux_cmd display-message -p -t "$SESSION_NAME:0.0" '#{pane_current_path}')" = "$expected_target"
  manifest="$RUN_DIR/manifest.json"
  jq -e --arg target "$expected_target" '.team == "deep-audit" and .working_directory == $target and .parent_session_id != null' "$manifest" >/dev/null
  attach_pid="$(cat "$RUN_DIR/attach.pid")"
  kill -0 "$attach_pid"
  test -s "$RUN_DIR/bridge.log"
  PARENT_SESSION_ID="$(cat "$RUN_DIR/parent_session_id")"
  [ -n "$PARENT_SESSION_ID" ]
}

stop_active_run() {
  local run_dir="$RUN_DIR" session="$SESSION_NAME"
  tmux_cmd kill-session -t "$session" >/dev/null 2>&1 || true
  if [ -n "${runtime_pid:-}" ] && kill -0 "$runtime_pid" 2>/dev/null; then kill -TERM "$runtime_pid" 2>/dev/null || true; fi
  wait "${runtime_pid:-}" 2>/dev/null || true
  runtime_pid=""
  active_session=""
  for _ in $(seq 1 30); do [ ! -e "$run_dir" ] && break; sleep 0.2; done
  [ ! -e "$run_dir" ] || { printf 'runtime cleanup left active state behind: %s\n' "$run_dir" >&2; return 1; }
  ! tmux_cmd has-session -t "$session" 2>/dev/null
}

wait_for_resume_result() {
  local readiness run session run_id candidate_dir failure_reason
  for _ in $(seq 1 90); do
    readiness="$(TMUX_TMPDIR="$TMUX_TMPDIR" OPENCODE_TEAM_HOME="$TEAM_HOME" \
      OPENCODE_TEAM_DEPENDENCY_ROOT="$DEPENDENCY_ROOT" "$ROOT/bin/opencode-team" runtime-readiness 2>/dev/null || true)"
    run="$(printf '%s' "$readiness" | jq -r '[.runs[] | select(.ready == true and (.run | startswith("deep-audit/")))][0].run // empty' 2>/dev/null || true)"
    if [ -n "$run" ]; then
      RUN_REL="$run"
      RUN_DIR="$TEAM_HOME/cache/runtime/$RUN_REL"
      RUN_ID="${RUN_REL##*/}"
      SESSION_NAME="$TMUX_PREFIX-$RUN_ID"
      active_session="$SESSION_NAME"
      RESUME_RESULT=active
      return 0
    fi
    session="$(tmux_cmd list-sessions -F '#{session_name}' 2>/dev/null | while IFS= read -r name; do case "$name" in "$TMUX_PREFIX-"????????) printf '%s\n' "$name" ;; esac; done | head -n 1)"
    if [ -n "$session" ]; then
      run_id="${session##*-}"
      candidate_dir="$TEAM_HOME/cache/runtime/deep-audit/runs/$run_id"
      if [ -f "$candidate_dir/manifest.json" ]; then
        failure_reason="$(jq -r '.failure_reason // empty' "$candidate_dir/manifest.json" 2>/dev/null || true)"
        case "$failure_reason" in
          *'does not belong to team deep-audit'*)
            SESSION_NAME="$session"
            RUN_ID="$run_id"
            RUN_DIR="$candidate_dir"
            active_session="$SESSION_NAME"
            RESUME_RESULT=provenance
            return 0
            ;;
        esac
      fi
    fi
    sleep 1
  done
  printf 'resume result did not settle: %s\n' "${readiness:-unavailable}" >&2
  tmux_cmd list-sessions >&2 || true
  while IFS= read -r session; do
    case "$session" in "$TMUX_PREFIX-"*) tmux_cmd capture-pane -p -t "$session:0.0" >&2 || true ;; esac
  done < <(tmux_cmd list-sessions -F '#{session_name}' 2>/dev/null || true)
  return 1
}

stop_failed_run() {
  local run_dir="$RUN_DIR" session="$SESSION_NAME"
  tmux_cmd kill-session -t "$session" >/dev/null 2>&1 || true
  if [ -n "${runtime_pid:-}" ] && kill -0 "$runtime_pid" 2>/dev/null; then kill -TERM "$runtime_pid" 2>/dev/null || true; fi
  wait "${runtime_pid:-}" 2>/dev/null || true
  runtime_pid=""
  active_session=""
  ! tmux_cmd has-session -t "$session" 2>/dev/null
  # Core deliberately retains failed manifests for diagnosis; the test fixture
  # directory is disposable and is removed by cleanup().
  [ -f "$run_dir/manifest.json" ]
}

start_audit "$FIXTURE/new-session.log" "$TARGET"
if ! wait_for_active_run; then
  cat "$FIXTURE/new-session.log" >&2
  printf '%s\n' 'real tmux Deep Audit session did not reach ACTIVE with an attach process' >&2
  exit 1
fi
assert_active_context "$target_real"
first_run_id="$RUN_ID"
original_session_id="$PARENT_SESSION_ID"
stop_active_run
test "$(tree_hash "$TARGET")" = "$target_before"

# Resume the same OpenCode session from its original project. A fresh unauthenticated
# root session has no assistant provenance, so either it becomes ACTIVE or the
# existing team-provenance guard refuses it only after the target binding passed.
start_audit "$FIXTURE/resume-match.log" --resume "$original_session_id" "$TARGET"
if ! wait_for_resume_result; then
  cat "$FIXTURE/resume-match.log" >&2
  printf '%s\n' 'matching Deep Audit resume did not reach an active or provenance-checked result' >&2
  exit 1
fi
test "$RUN_ID" != "$first_run_id"
if [ "$RESUME_RESULT" = active ]; then
  assert_active_context "$target_real"
  test "$(cat "$RUN_DIR/parent_session_id")" = "$original_session_id"
  stop_active_run
else
  jq -e --arg target "$target_real" '.status == "FAILED" and .working_directory == $target and (.failure_reason | contains("does not belong to team deep-audit"))' "$RUN_DIR/manifest.json" >/dev/null
  test "$(cat "$RUN_DIR/session_directory")" = "$target_real"
  resume_pane="$(tmux_cmd capture-pane -p -t "$SESSION_NAME:0.0")"
  if printf '%s' "$resume_pane" | rg -q 'resume target does not match'; then
    printf '%s\n' 'same-project resume was incorrectly rejected as a target mismatch' >&2
    exit 1
  fi
  if printf '%s' "$resume_pane" | rg -q 'Abort trap: 6'; then
    printf '%s\n' 'matching-resume provenance failure caused an Abort trap 6' >&2
    exit 1
  fi
  stop_failed_run
  printf '%s\n' 'Matching path binding reached the resume-provenance check; no model-authored history exists in the unauthenticated fixture.'
fi

# Resuming the same session from another directory must fail before server
# startup and must not produce an Abort trap during runtime cleanup.
start_audit "$FIXTURE/resume-mismatch.log" --resume "$original_session_id" "$OTHER_TARGET"
SESSION_NAME=""
for _ in $(seq 1 30); do
  SESSION_NAME="$(tmux_cmd list-sessions -F '#{session_name}' 2>/dev/null | while IFS= read -r name; do case "$name" in "$TMUX_PREFIX-"????????) printf '%s\n' "$name" ;; esac; done | head -n 1)"
  [ -n "$SESSION_NAME" ] && break
  sleep 0.2
done
[ -n "$SESSION_NAME" ] || { cat "$FIXTURE/resume-mismatch.log" >&2; printf '%s\n' 'mismatched resume did not create its guarded tmux pane' >&2; exit 1; }
active_session="$SESSION_NAME"
RUN_ID="${SESSION_NAME##*-}"
RUN_DIR="$TEAM_HOME/cache/runtime/deep-audit/runs/$RUN_ID"
for _ in $(seq 1 30); do [ -f "$RUN_DIR/manifest.json" ] && break; sleep 0.2; done
test -f "$RUN_DIR/manifest.json"
jq -e '.status == "FAILED" and (.failure_reason | contains("resume target does not match"))' "$RUN_DIR/manifest.json" >/dev/null
test "$(cat "$RUN_DIR/session_directory")" = "$target_real"
test ! -f "$RUN_DIR/server.pid"
failure_pane="$(tmux_cmd capture-pane -p -t "$SESSION_NAME:0.0")"
printf '%s' "$failure_pane" | rg -q 'resume target does not match the session.s original project'
if printf '%s' "$failure_pane" | rg -q 'Abort trap: 6'; then
  printf '%s\n' 'mismatched resume caused an independent Abort trap 6' >&2
  exit 1
fi
tmux_cmd kill-session -t "$SESSION_NAME" >/dev/null 2>&1 || true
active_session=""
if [ -n "${runtime_pid:-}" ] && kill -0 "$runtime_pid" 2>/dev/null; then kill -TERM "$runtime_pid" 2>/dev/null || true; fi
wait "${runtime_pid:-}" 2>/dev/null || true
runtime_pid=""
test "$(tree_hash "$TARGET")" = "$target_before"
printf '%s\n' 'DEEP_AUDIT_TMUX_RUNTIME PASS (new, existing server, spaced target, resume/mismatch, manifest, TUI attach, cleanup)'
