#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/opencode-team-setup.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

OPENCODE_TEAM_HOME="$TEST_ROOT" "$ROOT/bin/opencode-team" setup >/tmp/opencode-team-setup-smoke.out
for team in best go openai; do
  test -f "$TEST_ROOT/config/$team/team-runtime.conf"
  test -f "$TEST_ROOT/config/$team/opencode.jsonc"
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$TEST_ROOT/config/$team/opencode.jsonc"
done
test -f "$TEST_ROOT/config/openai/xdg-config/opencode/tui.json"

before="$(shasum -a 256 "$TEST_ROOT"/config/*/{team-runtime.conf,opencode.jsonc} "$TEST_ROOT/config/openai/xdg-config/opencode/tui.json")"
OPENCODE_TEAM_HOME="$TEST_ROOT" "$ROOT/bin/opencode-team" setup >/tmp/opencode-team-setup-smoke-second.out
after="$(shasum -a 256 "$TEST_ROOT"/config/*/{team-runtime.conf,opencode.jsonc} "$TEST_ROOT/config/openai/xdg-config/opencode/tui.json")"
test "$before" = "$after"
printf '%s\n' 'SETUP SMOKE PASS'
