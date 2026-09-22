#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/opencode-team-homebrew-setup.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

make_stub_bin() {
  local stub_bin="$1"
  local path_bin="$stub_bin/path"
  mkdir -p "$path_bin"
  for command_name in node npm python3 opencode git jq tmux uv rg curl; do
    ln -s "$(command -v "$command_name")" "$path_bin/$command_name"
  done
  mkdir -p "$path_bin/bin"
  ln -s "$path_bin/opencode" "$path_bin/bin/opencode"
  printf '%s\n' '#!/usr/bin/env bash' \
    'if [ "${1:-}" = "--prefix" ]; then' \
    '  if [ -n "${BREW_STUB_PREFIX:-}" ]; then printf "%s\\n" "$BREW_STUB_PREFIX"; exit 0; fi' \
    '  printf "%s\\n" "$BREW_STUB_BIN"' \
    '  exit 0' \
    'fi' \
    'printf "cleanup=%s args=%s\\n" "${HOMEBREW_NO_INSTALL_CLEANUP:-}" "$*" >> "$BREW_STUB_LOG"' \
    'if [ "${BREW_STUB_FAIL:-0}" = 1 ]; then exit 37; fi' \
    'printf "%s\\n" "#!/usr/bin/env bash" "exit 0" > "$BREW_STUB_BIN/codex"' \
    'chmod 755 "$BREW_STUB_BIN/codex"' \
    >"$path_bin/brew"
  chmod 755 "$path_bin/brew"
  printf '%s\n' '#!/usr/bin/env bash' 'if [ "${1:-}" = isexcluded ]; then printf "%s\n" "[Excluded]"; fi' 'exit 0' >"$path_bin/tmutil"
  chmod 755 "$path_bin/tmutil"
}

run_setup() {
  local home="$1" dependency_root="$2" stub_bin="$3" output="$4" brew_prefix="${5:-}"
  local rc
  set +e
  PATH="$stub_bin/path:/usr/bin:/bin" \
    BREW_STUB_BIN="$stub_bin/path" \
    BREW_STUB_LOG="$stub_bin/path/brew.log" \
    BREW_STUB_PREFIX="$brew_prefix" \
    BROKEN_PYTHON_LOG="$stub_bin/path/broken-python.log" \
    OPENCODE_TEAM_HOME="$home" \
    OPENCODE_TEAM_DEPENDENCY_ROOT="$dependency_root" \
    bash "$ROOT/bin/opencode-team" setup >"$output" 2>&1
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    cat "$output" >&2
    return "$rc"
  fi
}

make_broken_host_python() {
  local stub_bin="$1"
  rm -f "$stub_bin/path/python3"
  printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "BROKEN HOST PYTHON WAS INVOKED" >>"$BROKEN_PYTHON_LOG"' 'exit 97' >"$stub_bin/path/python3"
  chmod 755 "$stub_bin/path/python3"
}

make_launchctl_stub() {
  local stub_bin="$1"
  printf '%s\n' '#!/usr/bin/env bash' \
    'case "${1:-}" in' \
    '  print) [ "${LAUNCHCTL_MODE:-success}" = success ] && [ -f "$LAUNCHCTL_STATE" ] && exit 0; exit 1 ;;' \
    '  bootstrap) [ "${LAUNCHCTL_MODE:-success}" = bootstrap-fail ] && exit 42; touch "$LAUNCHCTL_STATE"; exit 0 ;;' \
    '  enable) exit 0 ;;' \
    '  bootout) rm -f "$LAUNCHCTL_STATE"; exit 0 ;;' \
    '  *) exit 1 ;;' \
    'esac' >"$stub_bin/path/launchctl"
  chmod 755 "$stub_bin/path/launchctl"
}

make_rename_failure_mv() {
  local stub_bin="$1"
  printf '%s\n' '#!/usr/bin/env bash' 'case "${2:-}" in *runtime-gc.plist) exit 43 ;; esac' 'exec /bin/mv "$@"' >"$stub_bin/path/mv"
  chmod 755 "$stub_bin/path/mv"
}

success_home="$TEST_ROOT/success-home"
success_dependencies="$TEST_ROOT/success-dependencies"
success_bin="$TEST_ROOT/success-bin"
mkdir -p "$success_dependencies"
for dependency_name in best go openai bin uv-cache; do
  if [ -e "$HOME/.local/share/opencode-team/dependencies/$dependency_name" ]; then
    ln -s "$HOME/.local/share/opencode-team/dependencies/$dependency_name" "$success_dependencies/$dependency_name"
  fi
done
make_stub_bin "$success_bin"
run_setup "$success_home" "$success_dependencies" "$success_bin" "$TEST_ROOT/success.out"
rg -q '^cleanup=1 args=install --cask codex$' "$success_bin/path/brew.log"
rg -q 'Setup complete\. No runtime was started\.' "$TEST_ROOT/success.out"
for team in best go openai daily; do
  test -f "$success_home/config/$team/team-runtime.conf"
  test -f "$success_home/config/$team/opencode.jsonc"
done
test -f "$success_home/state/maintenance/launchagents/it.danilodantoni.opencode-team.runtime-gc.plist"

rm -rf "$success_home/config" "$success_home/state/maintenance"
run_setup "$success_home" "$success_dependencies" "$success_bin" "$TEST_ROOT/recovery.out"
rg -q 'Setup complete\. No runtime was started\.' "$TEST_ROOT/recovery.out"
OPENCODE_TEAM_HOME="$success_home" OPENCODE_TEAM_DEPENDENCY_ROOT="$success_dependencies" \
  BREW_STUB_BIN="$success_bin/path" BREW_STUB_PREFIX="$success_bin/path" \
  PATH="$success_bin/path:/usr/bin:/bin" bash "$ROOT/bin/opencode-team" doctor >"$TEST_ROOT/recovery-doctor.out" || {
    cat "$TEST_ROOT/recovery-doctor.out" >&2
    exit 1
  }
rg -q 'best profile[[:space:]]+CONFIGURED' "$TEST_ROOT/recovery-doctor.out"
rg -q 'go profile[[:space:]]+CONFIGURED' "$TEST_ROOT/recovery-doctor.out"
rg -q 'openai profile[[:space:]]+CONFIGURED' "$TEST_ROOT/recovery-doctor.out"
rg -q 'daily profile[[:space:]]+CONFIGURED' "$TEST_ROOT/recovery-doctor.out"
rg -q 'Runtime GC[[:space:]]+INSTALLED' "$TEST_ROOT/recovery-doctor.out"
stale_marker="$success_home/state/maintenance/status/runtime-gc"
stale_plist="$success_home/state/maintenance/launchagents/it.danilodantoni.opencode-team.runtime-gc.plist"
printf '%s\n' INSTALLED >"$stale_marker"
rm -f "$stale_plist"
set +e
OPENCODE_TEAM_HOME="$success_home" OPENCODE_TEAM_DEPENDENCY_ROOT="$success_dependencies" \
  BREW_STUB_BIN="$success_bin/path" BREW_STUB_PREFIX="$success_bin/path" \
  PATH="$success_bin/path:/usr/bin:/bin" bash "$ROOT/bin/opencode-team" doctor >"$TEST_ROOT/stale-doctor.out" 2>&1
stale_rc=$?
set -e
test "$stale_rc" -eq 1
rg -q 'Runtime GC[[:space:]]+BROKEN' "$TEST_ROOT/stale-doctor.out"
run_setup "$success_home" "$success_dependencies" "$success_bin" "$TEST_ROOT/third.out"

broken_home="$TEST_ROOT/broken-python-home"
broken_bin="$TEST_ROOT/broken-python-bin"
broken_dependencies="$TEST_ROOT/broken-python-dependencies"
mkdir -p "$broken_dependencies"
for dependency_name in best go openai serena bin uv-cache; do
  if [ -e "$success_dependencies/$dependency_name" ]; then
    ln -s "$success_dependencies/$dependency_name" "$broken_dependencies/$dependency_name"
  fi
done
make_stub_bin "$broken_bin"
make_broken_host_python "$broken_bin"
run_setup "$broken_home" "$broken_dependencies" "$broken_bin" "$TEST_ROOT/broken-python.out"
test ! -s "$broken_bin/path/broken-python.log"
rg -q '^OPENCODE_TEAM_PYTHON=.*/python/cpython-3\.13[^/]*/bin/python3\.13$' "$broken_home/config/best/team-runtime.conf"
OPENCODE_TEAM_HOME="$broken_home" OPENCODE_TEAM_DEPENDENCY_ROOT="$broken_dependencies" \
  BREW_STUB_BIN="$broken_bin/path" BREW_STUB_PREFIX="$broken_bin/path" \
  PATH="$broken_bin/path:/usr/bin:/bin" bash "$ROOT/bin/opencode-team" doctor >"$TEST_ROOT/broken-python-doctor.out" 2>&1 || {
    cat "$TEST_ROOT/broken-python-doctor.out" >&2
    exit 1
  }
rg -q 'Managed Python[[:space:]]+OK' "$TEST_ROOT/broken-python-doctor.out"

shadow_home="$TEST_ROOT/shadow-home"
shadow_bin="$TEST_ROOT/shadow-bin"
core_opencode_prefix="$TEST_ROOT/core-opencode"
make_stub_bin "$shadow_bin"
mkdir -p "$core_opencode_prefix/bin"
ln -s "$(command -v opencode)" "$core_opencode_prefix/bin/opencode"
rm -f "$shadow_bin/path/opencode"
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "PATH SHADOW OPENCODE WAS INVOKED" >>"$SHADOW_OPENCODE_LOG"' 'exit 99' >"$shadow_bin/path/opencode"
chmod 755 "$shadow_bin/path/opencode"
SHADOW_OPENCODE_LOG="$shadow_bin/path/shadow-opencode.log" \
  run_setup "$shadow_home" "$success_dependencies" "$shadow_bin" "$TEST_ROOT/shadow.out" "$core_opencode_prefix"
if [ -s "$shadow_bin/path/shadow-opencode.log" ]; then
  cat "$shadow_bin/path/shadow-opencode.log" >&2
  exit 1
fi
rg -q "^OPENCODE_BIN=$core_opencode_prefix/bin/opencode$" "$shadow_home/config/best/team-runtime.conf"
test "$(BREW_STUB_PREFIX="$core_opencode_prefix" PATH="$shadow_bin/path:/usr/bin:/bin" brew --prefix opencode)" = "$core_opencode_prefix"
test -x "$core_opencode_prefix/bin/opencode"
SHADOW_OPENCODE_LOG="$shadow_bin/path/shadow-opencode.log" \
  BREW_STUB_PREFIX="$core_opencode_prefix" \
  OPENCODE_TEAM_HOME="$shadow_home" OPENCODE_TEAM_DEPENDENCY_ROOT="$success_dependencies" \
  PATH="$shadow_bin/path:/usr/bin:/bin" bash "$ROOT/bin/opencode-team" doctor >"$TEST_ROOT/shadow-doctor.out" 2>&1 || {
    cat "$TEST_ROOT/shadow-doctor.out" >&2
    exit 1
  }
rg -q "OpenCode[[:space:]]+OK \($core_opencode_prefix/bin/opencode\)" "$TEST_ROOT/shadow-doctor.out"

for launchctl_mode in bootstrap-fail verify-fail; do
  launchctl_home="$TEST_ROOT/launchctl-$launchctl_mode-home"
  launchctl_bin="$TEST_ROOT/launchctl-$launchctl_mode-bin"
  make_stub_bin "$launchctl_bin"
  make_launchctl_stub "$launchctl_bin"
  set +e
  HOME="$launchctl_home" \
    OPENCODE_TEAM_DEPENDENCY_ROOT="$success_dependencies" \
    LAUNCHCTL_MODE="$launchctl_mode" \
    LAUNCHCTL_STATE="$launchctl_bin/path/launchctl.state" \
    PATH="$launchctl_bin/path:/usr/bin:/bin" \
    BREW_STUB_BIN="$launchctl_bin/path" \
    BREW_STUB_LOG="$launchctl_bin/path/brew.log" \
    BROKEN_PYTHON_LOG="$launchctl_bin/path/broken-python.log" \
    bash "$ROOT/bin/opencode-team" setup >"$TEST_ROOT/$launchctl_mode.out" 2>&1
  launchctl_rc=$?
  set -e
  test "$launchctl_rc" -eq 1
  ! rg -q 'OK \(INSTALLED\)' "$TEST_ROOT/$launchctl_mode.out"
  test ! -f "$launchctl_home/.local/state/opencode-team/maintenance/status/runtime-gc"
done

failure_home="$TEST_ROOT/failure-home"
failure_dependencies="$success_dependencies"
failure_bin="$TEST_ROOT/failure-bin"
make_stub_bin "$failure_bin"
set +e
PATH="$failure_bin/path:/usr/bin:/bin" \
  BREW_STUB_BIN="$failure_bin/path" \
  BREW_STUB_FAIL=1 \
  BREW_STUB_LOG="$failure_bin/path/brew.log" \
  OPENCODE_TEAM_HOME="$failure_home" \
  OPENCODE_TEAM_DEPENDENCY_ROOT="$failure_dependencies" \
  bash "$ROOT/bin/opencode-team" setup >"$TEST_ROOT/failure.out" 2>&1
failure_rc=$?
set -e
test "$failure_rc" -eq 1
rg -q '^cleanup=1 args=install --cask codex$' "$failure_bin/path/brew.log"
test ! -f "$failure_home/config/best/team-runtime.conf"

plist_failure_home="$TEST_ROOT/plist-failure-home"
plist_failure_bin="$TEST_ROOT/plist-failure-bin"
make_stub_bin "$plist_failure_bin"
printf '%s\n' '#!/usr/bin/env bash' 'exit 41' >"$plist_failure_bin/path/plutil"
chmod 755 "$plist_failure_bin/path/plutil"
set +e
PATH="$plist_failure_bin/path:/usr/bin:/bin" \
  BREW_STUB_BIN="$plist_failure_bin/path" \
  BREW_STUB_LOG="$plist_failure_bin/path/brew.log" \
  OPENCODE_TEAM_HOME="$plist_failure_home" \
  OPENCODE_TEAM_DEPENDENCY_ROOT="$success_dependencies" \
  bash "$ROOT/bin/opencode-team" setup >"$TEST_ROOT/plist-failure.out" 2>&1
plist_failure_rc=$?
set -e
test "$plist_failure_rc" -eq 1
test ! -f "$plist_failure_home/state/maintenance/status/runtime-gc"

rename_failure_home="$TEST_ROOT/rename-failure-home"
rename_failure_bin="$TEST_ROOT/rename-failure-bin"
make_stub_bin "$rename_failure_bin"
make_rename_failure_mv "$rename_failure_bin"
set +e
PATH="$rename_failure_bin/path:/usr/bin:/bin" \
  BREW_STUB_BIN="$rename_failure_bin/path" \
  BREW_STUB_LOG="$rename_failure_bin/path/brew.log" \
  BROKEN_PYTHON_LOG="$rename_failure_bin/path/broken-python.log" \
  OPENCODE_TEAM_HOME="$rename_failure_home" \
  OPENCODE_TEAM_DEPENDENCY_ROOT="$success_dependencies" \
  bash "$ROOT/bin/opencode-team" setup >"$TEST_ROOT/rename-failure.out" 2>&1
rename_failure_rc=$?
set -e
test "$rename_failure_rc" -eq 1
! rg -q 'OK \(INSTALLED\)' "$TEST_ROOT/rename-failure.out"
test ! -f "$rename_failure_home/state/maintenance/status/runtime-gc"

printf '%s\n' 'HOMEBREW SETUP REGRESSION PASS'
