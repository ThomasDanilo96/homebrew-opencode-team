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
for team in best go openai daily; do
  test -f "$TEST_ROOT/config/$team/team-runtime.conf"
  test -f "$TEST_ROOT/config/$team/opencode.jsonc"
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$TEST_ROOT/config/$team/opencode.jsonc"
  OPENCODE_CONFIG="$TEST_ROOT/config/$team/opencode.jsonc" \
    OPENCODE_CONFIG_DIR="$TEST_ROOT/config/$team" \
    OPENCODE_DISABLE_PROJECT_CONFIG=1 \
    XDG_CONFIG_HOME="$TEST_ROOT/config/$team/xdg-config" \
    XDG_DATA_HOME="$TEST_ROOT/data/$team/data" \
    XDG_CACHE_HOME="$TEST_ROOT/cache/$team" \
    XDG_STATE_HOME="$TEST_ROOT/state/$team" \
    opencode debug config >/dev/null
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
printf '%s\n' '{' >"$TEST_ROOT/config/daily/opencode.jsonc"
if OPENCODE_TEAM_HOME="$TEST_ROOT" "$ROOT/bin/opencode-team" doctor >/dev/null 2>&1; then
  printf '%s\n' 'doctor accepted an invalid DAILY config' >&2
  exit 1
fi
OPENCODE_TEAM_HOME="$TEST_ROOT" "$ROOT/bin/opencode-team" setup >/dev/null
mkdir -p "$TEST_ROOT/data/daily/state/team/work-packets"
printf '%s\n' '{"outcome":"completed","complexity":"TRIVIAL"}' >"$TEST_ROOT/data/daily/state/team/work-packets/0000000000000000000000000000000000000000000000000000000000000001.json"
report="$(OPENCODE_TEAM_HOME="$TEST_ROOT" "$ROOT/bin/opencode-team" daily-report)"
REPORT_JSON="$report" node -e 'const report = JSON.parse(process.env.REPORT_JSON); for (const field of ["completed_tasks", "estimated_total_usd", "cache_ratio_pct", "by_model", "by_complexity"]) if (!(field in report)) process.exit(1)'
REPORT_JSON="$report" node -e 'if (JSON.parse(process.env.REPORT_JSON).completed_tasks !== 1) process.exit(1)'
printf '%s\n' 'SETUP SMOKE PASS'
