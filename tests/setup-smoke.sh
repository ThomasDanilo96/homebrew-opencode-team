#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENCODE_TEAM_PACKAGE_ROOT:-$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/opencode-team-smoke.XXXXXX")"
TEAM_HOME="$TEST_ROOT/home"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

# This verifies the installed package and non-Docker configuration/security
# contracts. Full profile provisioning, including Docker-backed test runners,
# remains a separate opt-in/runtime gate.
node --test "$ROOT/tests/opencode-team-launcher-regression.test.mjs"
node --test "$ROOT/tests/best-ecc-config.test.mjs" "$ROOT/tests/best-cli-routing.test.mjs"
node --test "$ROOT/tests/deep-audit-cli.test.mjs" "$ROOT/tests/deep-audit-report.test.mjs"
bash "$ROOT/tests/zsh-completion.test.sh"

test -x "$ROOT/bin/opencode-team"
test -x "$ROOT/bin/opencode-daily-team"
test -x "$ROOT/teams/deep-audit/bin/read-only-opencode.sh"
for asset in \
  "$ROOT/VERSION" \
  "$ROOT/completions/_opencode-team" \
  "$ROOT/teams/deep-audit/bin/read-only-opencode.sh" \
  "$ROOT/teams/deep-audit/opencode.jsonc.template" \
  "$ROOT/teams/deep-audit/setup-scanners.sh" \
  "$ROOT/teams/deep-audit/setup-test-runners.sh" \
  "$ROOT/teams/deep-audit/test-runner-plugin.mjs.template" \
  "$ROOT/teams/deep-audit/test-runner-integrity.mjs" \
  "$ROOT/teams/deep-audit/test-runners/images.lock.json" \
  "$ROOT/teams/deep-audit/test-runners/python.Dockerfile" \
  "$ROOT/teams/deep-audit/test-runners/php.Dockerfile" \
  "$ROOT/teams/deep-audit/rules/semgrep.yml"; do
  test -f "$asset"
done
test -x "$ROOT/bin/opencode-team"
test -x "$ROOT/bin/opencode-daily-team"
test -x "$ROOT/teams/deep-audit/bin/read-only-opencode.sh"

# Exercise the installed macOS Seatbelt policy with a harmless fixture; this
# does not provision or invoke Docker.
bash "$ROOT/tests/deep-audit-sandbox.test.sh"

version="$(cat "$ROOT/VERSION")"
test "$("$ROOT/bin/opencode-team" version)" = "OpenCode Team $version"
"$ROOT/bin/opencode-team" --help >"$TEST_ROOT/help"
for phrase in 'BEST profile' free 'alias for best' best-native best-ecc; do
  rg -Fq "$phrase" "$TEST_ROOT/help"
done

TEAM_NAME=opencode-openai-daily OMO_PROFILE=openai-daily BRIDGE_MODE=native_ui \
  OPENCODE_CONFIG="$TEAM_HOME/config/daily/opencode.jsonc" \
  OPENCODE_CONFIG_DIR="$TEAM_HOME/config/daily" \
  SANDBOX="$TEAM_HOME/data/daily" \
  XDG_CONFIG_HOME_OVERRIDE="$TEAM_HOME/config/daily/xdg-config" \
  XDG_DATA_HOME="$TEAM_HOME/data/daily/data" \
  XDG_STATE_HOME="$TEAM_HOME/state/daily" PORT=0 \
  bash -c 'source "$1/core/lib/core.sh"; export_env; test -z "${OMO_PROFILE+x}"' bash "$ROOT"

printf '%s\n' 'PACKAGING CONFIG SMOKE PASS (macOS Seatbelt policy verified; Docker test-runner provisioning not run)'
