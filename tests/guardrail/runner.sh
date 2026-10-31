#!/usr/bin/env bash
# Guardrail runner for the mock-only test suite (macOS, sandbox-exec).
#
# Staging isolation: copies tracked source into a fresh mktemp root, sets
# HOME/OPENCODE_TEAM_HOME/TMPDIR inside it, then runs the suite under
# sandbox-exec with env -i + trusted PATH. The sandbox denies reads of real
# HOME and a sentinel dir outside staging, confines all writes to staging
# root, and denies all network except unix bind.
#
# bash3-compatible (no mapfile, no declare -A). Exits 70 if sandbox-exec absent.
# Uses "$@" for command args. All paths resolved via realpath so the sandbox's
# symlink resolution matches.

set -euo pipefail

GUARDRAIL_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd -P "$GUARDRAIL_DIR/../.." && pwd)"
PROFILE_SRC="$GUARDRAIL_DIR/profile.sb"
SANDBOX_EXEC="/usr/bin/sandbox-exec"

if [ ! -x "$SANDBOX_EXEC" ]; then
  echo "guardrail FAIL: sandbox-exec required at $SANDBOX_EXEC" >&2
  echo "guardrail: OS-level isolation unavailable; refusing to run unguarded." >&2
  exit 70
fi

realpath_cmd() {
  /usr/bin/python3 -I -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$1"
}

ACCOUNT_HOME="$(/usr/bin/python3 -I -c 'import os,pwd; print(pwd.getpwuid(os.getuid()).pw_dir)')"
REAL_HOME="$(realpath_cmd "$ACCOUNT_HOME")"
REAL_TEAM="$(realpath_cmd "${OPENCODE_TEAM_HOME:-$HOME/.local/share/opencode-team}")"

STAGING=""
OUTSIDE=""

cleanup() {
  cd "${TMPDIR:-/tmp}" 2>/dev/null || cd / 2>/dev/null || true
  if [ -n "$STAGING" ] && [ -d "$STAGING" ]; then
    rm -rf "$STAGING"
  fi
  if [ -n "$OUTSIDE" ] && [ -d "$OUTSIDE" ]; then
    rm -rf "$OUTSIDE"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

_tmp_base="$(realpath_cmd "${TMPDIR:-/tmp}")"
STAGING="$(mktemp -d "${_tmp_base}/ocgt.XXXXXXXX")"
OUTSIDE="$(mktemp -d "${_tmp_base}/ocgt-out.XXXXXXXX")"
STAGING_REAL="$(realpath_cmd "$STAGING")"
OUTSIDE_REAL="$(realpath_cmd "$OUTSIDE")"
mkdir -p "$STAGING/home" "$STAGING/team" "$STAGING/tmp"
# zsh heredoc temp dir — zsh uses $TMPPREFIX (default /tmp/zsh) for heredoc
# temp files. Point it inside staging so heredocs work under the strict
# sandbox (writes confined to staging root).
mkdir -p "$STAGING/zsh"
echo "ocgt-sentinel" > "$OUTSIDE/sentinel.txt"

copy_tree() {
  local src="$1" dst="$2"
  mkdir -p "$dst"
  cp -a "$src/." "$dst/"
}
for d in bin shared tests Formula completions .github; do
  if [ -d "$REPO/$d" ]; then
    copy_tree "$REPO/$d" "$STAGING/$d"
  fi
done
for f in VERSION; do
  if [ -f "$REPO/$f" ]; then
    cp -p "$REPO/$f" "$STAGING/$f"
  fi
done
find "$STAGING" -type d -name "__pycache__" -exec rm -rf {} +

PROFILE="$STAGING/.sandbox.sb"
/usr/bin/python3 -I - "$PROFILE_SRC" "$PROFILE" "$STAGING_REAL" "$OUTSIDE_REAL" "$REAL_HOME" "$REAL_TEAM" <<'PY'
import json
import pathlib
import sys

source, destination, *values = sys.argv[1:]
text = pathlib.Path(source).read_text()
for name, value in zip(("STAGING_ROOT", "OUTSIDE_ROOT", "REAL_HOME", "REAL_TEAM"), values):
    text = text.replace("@" + name + "@", json.dumps(value))
pathlib.Path(destination).write_text(text)
PY

TRUSTED_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

RC=0

# Run a suite under sandbox-exec, capturing its exit code without tripping set -e.
# The command is passed via "$@" (not bash -c). CWD is staging (cd'd below).
run_suite() {
  local output
  local rc=0
  if output="$(env -i \
    "$SANDBOX_EXEC" -f "$PROFILE" \
    env -i HOME="$STAGING/home" OPENCODE_TEAM_HOME="$STAGING/team" TMPDIR="$STAGING/tmp" \
      TMPPREFIX="$STAGING/zsh/ocgt-" \
      PATH="$TRUSTED_PATH" LANG=C \
      OPENCODE_TEAM_STAGING_ROOT="$STAGING_REAL" \
      OPENCODE_TEAM_OUTSIDE_ROOT="$OUTSIDE_REAL" \
      OPENCODE_TEAM_REAL_HOME="$REAL_HOME" \
    "$@" 2>&1)"; then
    :
  else
    rc=$?
  fi
  echo "$output"
  if [ "$rc" -ne 0 ]; then
    RC=1
  fi
  return "$rc"
}

# cd into staging so the sandboxed process starts outside HOME (frozen importlib
# reads CWD on startup).
if [ "${1:-}" = best-routing ] && [ "$#" -eq 3 ]; then
  ROUTING_CONFIG_SOURCE="$(realpath_cmd "$2")"
  ROUTING_AVAILABILITY_SOURCE="$(realpath_cmd "$3")"
fi
if [ "${1:-}" = best-routing ] && [ "$#" -eq 4 ]; then
  ROUTING_CONFIG_SOURCE="$(realpath_cmd "$2")"
  ROUTING_AVAILABILITY_SOURCE="$(realpath_cmd "$3")"
  ROUTING_INSTRUCTIONS_SOURCE="$(realpath_cmd "$4")"
fi
cd "$STAGING"
target="${1:-all}"
case "$target" in all|smoke|maintenance|benchmark|profile|qualification|homebrew|compatibility|rollback|best-routing) ;; *) echo "unknown target: $target" >&2; exit 2 ;; esac

echo "## guardrail: staging at $STAGING_REAL"
echo "## guardrail: outside sentinel at $OUTSIDE_REAL"
echo "## guardrail: sandbox-exec OK"
echo ""

echo "## Isolation negative-control suite"
run_suite /usr/bin/python3 -B tests/test_isolation.py -v 2>&1 || exit 1
echo ""
if [ "$target" = best-routing ]; then
  run_suite node --test tests/best-routing.test.mjs || exit 1
  if [ "$#" -eq 3 ] || [ "$#" -eq 4 ]; then
    cp -p "$ROUTING_CONFIG_SOURCE" "$STAGING/best-routing-config.json"
    cp -p "$ROUTING_AVAILABILITY_SOURCE" "$STAGING/best-routing-availability.json"
    if [ -n "${ROUTING_INSTRUCTIONS_SOURCE:-}" ] && [ -f "$ROUTING_INSTRUCTIONS_SOURCE" ]; then
      cp -p "$ROUTING_INSTRUCTIONS_SOURCE" "$STAGING/best-handoff-instructions.md"
      run_suite node --test tests/best-claude-handoff.test.mjs || exit 1
    fi
    run_suite node --test tests/best-config.test.mjs || exit 1
  elif [ "$#" -ne 1 ]; then
    echo "Use runner.sh best-routing [CONFIG AVAILABILITY [INSTRUCTIONS]]"; exit 2
  fi
  exit "$RC"
fi
if [ "$target" = rollback ]; then
  [ "$#" -eq 3 ] || { echo "Use runner.sh rollback ARCHIVE MANIFEST"; exit 2; }
  run_suite /usr/bin/python3 -B tests/code_rollback.py "$2" "$3" || exit 1
  exit "$RC"
fi
if [ "$target" = compatibility ]; then
  [ -x /opt/homebrew/bin/python3.13 ] || { echo "Python 3.13 check BLOCKED: interpreter unavailable"; exit 70; }
  run_suite /opt/homebrew/bin/python3.13 --version || exit 1
  run_suite /opt/homebrew/bin/python3.13 -B tests/test_maintenance.py -v 2>&1 || :
  run_suite /opt/homebrew/bin/python3.13 -B tests/test_maintenance_evidence.py -v 2>&1 || :
  [ -x /opt/homebrew/opt/node@22/bin/node ] || { echo "Node 22 check BLOCKED: interpreter unavailable"; exit 70; }
  run_suite /opt/homebrew/opt/node@22/bin/node --version || exit 1
  for suite in native-profiles disk-cleanup hybrid-evidence packaging best-routing; do
    run_suite /usr/bin/env PATH="/opt/homebrew/opt/node@22/bin:$TRUSTED_PATH" \
      /opt/homebrew/opt/node@22/bin/node --test "tests/${suite}.test.mjs" 2>&1 || :
  done
  exit "$RC"
fi

if [ "$target" = benchmark ] || [ "$target" = profile ] || [ "$target" = qualification ]; then
  run_suite /usr/bin/python3 -B tests/test_benchmark_maintenance.py -v 2>&1 || exit 1
  run_suite /usr/bin/python3 -B -c '
import subprocess, sys
try:
    result = subprocess.run([sys.executable, "-B", "tests/benchmark_maintenance.py", sys.argv[1]], timeout=5400 if sys.argv[1] == "qualification" else 1800)
    sys.exit(result.returncode)
except subprocess.TimeoutExpired:
    print("benchmark FAIL: bounded runtime exceeded")
    sys.exit(1)
' "$target" || exit 1
  exit "$RC"
fi
if [ "$target" = homebrew ]; then
  run_suite /usr/bin/python3 -B -c '
import os, signal, subprocess, sys
process = subprocess.Popen(["/bin/bash", "tests/homebrew-isolated.sh"], start_new_session=True)
try:
    code = process.wait(timeout=180)
except subprocess.TimeoutExpired:
    os.killpg(process.pid, signal.SIGKILL)
    process.wait()
    print("HOMEBREW_RESULT=BLOCKED phase=bounded-timeout")
    code = 3
sys.exit(code)
' || exit $?
  exit "$RC"
fi

echo "## Python maintenance suite"
run_suite /usr/bin/python3 -B tests/test_maintenance.py -v 2>&1 || :
run_suite /usr/bin/python3 -B tests/test_maintenance_evidence.py -v 2>&1 || :
echo ""
if [ "$target" = maintenance ]; then
  run_suite /usr/bin/python3 -B tests/test_benchmark_maintenance.py -v 2>&1 || :
  exit "$RC"
fi

if [ "$target" = smoke ]; then
  run_suite bash tests/setup-smoke.sh 2>&1 || :
  exit "$RC"
fi

run_suite /usr/bin/python3 -B tests/test_benchmark_maintenance.py -v 2>&1 || :

echo "## Node suites"
for suite in native-profiles disk-cleanup hybrid-evidence packaging best-routing; do
  echo "--- $suite ---"
  run_suite node --test "tests/${suite}.test.mjs" 2>&1 || :
done
echo ""

echo "## Shell suites"
run_suite bash tests/setup-smoke.sh 2>&1 || :
run_suite bash tests/homebrew-workflow.test.sh 2>&1 || :
echo ""

echo "## guardrail: done (exit=$RC)"
exit $RC
