#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/opencode-team-setup.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

OPENCODE_TEAM_HOME="$TEST_ROOT" "$ROOT/bin/opencode-team" setup >/tmp/opencode-team-setup-smoke.out
TUI_FILES=()
for template in "$ROOT"/teams/*/tui.json.template; do
  team="$(basename "$(dirname "$template")")"
  tui_file="$TEST_ROOT/config/$team/xdg-config/opencode/tui.json"
  TUI_FILES+=("$tui_file")
done
for team in best go openai; do
  test -f "$TEST_ROOT/config/$team/team-runtime.conf"
  test -f "$TEST_ROOT/config/$team/opencode.jsonc"
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$TEST_ROOT/config/$team/opencode.jsonc"
done
for tui_file in "${TUI_FILES[@]}"; do
  test -f "$tui_file"
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$tui_file"
done

CONFIG_FILES=("$TEST_ROOT"/config/*/{team-runtime.conf,opencode.jsonc})
before="$(shasum -a 256 "${CONFIG_FILES[@]}" "${TUI_FILES[@]}")"
OPENCODE_TEAM_HOME="$TEST_ROOT" "$ROOT/bin/opencode-team" setup >/tmp/opencode-team-setup-smoke-second.out
after="$(shasum -a 256 "${CONFIG_FILES[@]}" "${TUI_FILES[@]}")"
test "$before" = "$after"
printf '%s\n' 'SETUP SMOKE PASS'
