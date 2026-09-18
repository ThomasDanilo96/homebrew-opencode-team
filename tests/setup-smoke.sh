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

OLD_ROOT="$TEST_ROOT/version-a/brew-opencode-team/libexec"
node - "$TEST_ROOT/config" "$ROOT" "$OLD_ROOT" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [configRoot, currentRoot, oldRoot] = process.argv.slice(2);
for (const team of ["best", "go", "openai", "daily"]) {
  for (const file of ["team-runtime.conf", "opencode.jsonc", "tui.json", "settings.json"]) {
    const matches = [];
    const visit = (directory) => {
      if (!fs.existsSync(directory)) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(candidate);
        else if (entry.name === file) matches.push(candidate);
      }
    };
    visit(path.join(configRoot, team));
    for (const candidate of matches) {
      const contents = fs.readFileSync(candidate, "utf8");
      fs.writeFileSync(candidate, contents.replaceAll(currentRoot, oldRoot));
    }
  }
}
NODE

if ! OPENCODE_TEAM_HOME="$TEST_ROOT" "$ROOT/bin/opencode-team" doctor >/tmp/opencode-team-setup-smoke-upgrade.out; then
  cat /tmp/opencode-team-setup-smoke-upgrade.out >&2
  exit 1
fi
! rg -q '/Cellar/opencode-team/[0-9]' "$TEST_ROOT/config"
! rg -q "$OLD_ROOT" "$TEST_ROOT/config"
for team in best go openai daily; do
  bash -c 'source "$1/core/lib/config.sh"; parse_team_config "$2"' bash "$ROOT" "$TEST_ROOT/config/$team/team-runtime.conf"
  OPENCODE_CONFIG="$TEST_ROOT/config/$team/opencode.jsonc" \
    OPENCODE_CONFIG_DIR="$TEST_ROOT/config/$team" \
    OPENCODE_DISABLE_PROJECT_CONFIG=1 \
    XDG_CONFIG_HOME="$TEST_ROOT/config/$team/xdg-config" \
    XDG_DATA_HOME="$TEST_ROOT/data/$team/data" \
    XDG_CACHE_HOME="$TEST_ROOT/cache/$team" \
    XDG_STATE_HOME="$TEST_ROOT/state/$team" \
    opencode debug config >/dev/null
done

TEAM_NAME=opencode-openai-daily OMO_PROFILE=openai-daily \
  OPENCODE_CONFIG="$TEST_ROOT/config/daily/opencode.jsonc" \
  OPENCODE_CONFIG_DIR="$TEST_ROOT/config/daily" \
  SANDBOX="$TEST_ROOT/data/daily" \
  XDG_CONFIG_HOME_OVERRIDE="$TEST_ROOT/config/daily/xdg-config" \
  XDG_DATA_HOME="$TEST_ROOT/data/daily/data" \
  XDG_STATE_HOME="$TEST_ROOT/state/daily" \
  PORT=0 bash -c 'source "$1/core/lib/core.sh"; export_env; test -z "${OMO_PROFILE+x}"' bash "$ROOT"
printf '%s\n' 'UPGRADE CONFIG PASS'

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
