#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -x /opt/homebrew/opt/node@22/bin/node ]; then
  PATH="/opt/homebrew/opt/node@22/bin:$PATH"
  export PATH
fi
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/opencode-team-setup.XXXXXX")"
TEAM_HOME="$TEST_ROOT/home-a"
SECOND_TEAM_HOME="$TEST_ROOT/home-b"
DEP_ROOT="${OPENCODE_TEAM_TEST_DEPENDENCY_ROOT:-${TMPDIR:-/tmp}/opencode-team-shared-dependencies-${USER:-$(id -u)}}"
trap 'rm -rf "$TEST_ROOT"' EXIT

shared_bytes() {
  [ -d "$DEP_ROOT" ] || { printf '%s\n' 0; return; }
  du -sk "$DEP_ROOT" | awk '{print $1 * 1024}'
}

shared_before_bytes="$(shared_bytes)"

OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEP_ROOT" "$ROOT/bin/opencode-team" setup >/tmp/opencode-team-setup-smoke.out
first_shared_bytes="$(shared_bytes)"
TUI_FILES=()
for template in "$ROOT"/teams/*/tui.json.template; do
  team="$(basename "$(dirname "$template")")"
  tui_file="$TEAM_HOME/config/$team/xdg-config/opencode/tui.json"
  TUI_FILES+=("$tui_file")
done
for team in best go openai daily; do
  test -f "$TEAM_HOME/config/$team/team-runtime.conf"
  test -f "$TEAM_HOME/config/$team/opencode.jsonc"
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$TEAM_HOME/config/$team/opencode.jsonc"
done
for tui_file in "${TUI_FILES[@]}"; do
  test -f "$tui_file"
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$tui_file"
done

CONFIG_FILES=("$TEAM_HOME"/config/*/{team-runtime.conf,opencode.jsonc})
before="$(shasum -a 256 "${CONFIG_FILES[@]}" "${TUI_FILES[@]}")"
OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEP_ROOT" "$ROOT/bin/opencode-team" setup >/tmp/opencode-team-setup-smoke-second.out
after="$(shasum -a 256 "${CONFIG_FILES[@]}" "${TUI_FILES[@]}")"
test "$before" = "$after"

second_before_bytes="$(shared_bytes)"
OPENCODE_TEAM_HOME="$SECOND_TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEP_ROOT" "$ROOT/bin/opencode-team" setup >/tmp/opencode-team-setup-smoke-third.out
second_after_bytes="$(shared_bytes)"
test -d "$DEP_ROOT/best/node_modules/oh-my-openagent"
test -d "$DEP_ROOT/go/node_modules/oh-my-openagent"
test -d "$DEP_ROOT/openai/node_modules/oh-my-openagent"
test -x "$DEP_ROOT/bin/serena"
if find "$SECOND_TEAM_HOME" -path '*/node_modules/oh-my-openagent' -print -quit | rg -q .; then
  printf '%s\n' 'second isolated home duplicated OMO dependency tree' >&2
  exit 1
fi
shared_dependency_bytes="$(du -sk "$DEP_ROOT" | awk '{print $1 * 1024}')"
second_home_dependency_bytes="$(find "$SECOND_TEAM_HOME" -path '*/node_modules' -prune -exec du -sk {} + 2>/dev/null | awk '{sum += $1 * 1024} END {print sum + 0}')"
first_setup_dependency_bytes="$((first_shared_bytes - shared_before_bytes))"
second_setup_dependency_bytes="$((second_after_bytes - second_before_bytes))"
printf 'shared_dependency_bytes=%s\nfirst_setup_dependency_bytes=%s\nsecond_setup_dependency_bytes=%s\nsecond_home_node_modules_bytes=%s\n' "$shared_dependency_bytes" "$first_setup_dependency_bytes" "$second_setup_dependency_bytes" "$second_home_dependency_bytes" >"$TEST_ROOT/dependency-sharing-evidence.txt"
test "$shared_dependency_bytes" -gt 0
test "$second_home_dependency_bytes" -eq 0
test "$second_setup_dependency_bytes" -le 0

OLD_ROOT="$TEST_ROOT/version-a/brew-opencode-team/libexec"
node - "$TEAM_HOME/config" "$ROOT" "$OLD_ROOT" <<'NODE'
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
      let contents = fs.readFileSync(candidate, "utf8").replaceAll(currentRoot, oldRoot);
      if (file === "team-runtime.conf") {
        contents = contents.replace(/^RUNTIME_ROOT=.*\n/gm, "").replace(/^PERSISTENT_DATA_ROOT=.*\n/gm, "");
      }
      fs.writeFileSync(candidate, contents);
    }
  }
}
NODE

for team in best go openai daily; do
  rm -rf "$TEAM_HOME/cache/runtime/$team" "$TEAM_HOME/data/$team/data"
done

if ! OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEP_ROOT" "$ROOT/bin/opencode-team" doctor >/tmp/opencode-team-setup-smoke-upgrade.out; then
  cat /tmp/opencode-team-setup-smoke-upgrade.out >&2
  exit 1
fi
! rg -q '/Cellar/opencode-team/[0-9]' "$TEAM_HOME/config"
! rg -q "$OLD_ROOT" "$TEAM_HOME/config"
for team in best go openai daily; do
  test -d "$TEAM_HOME/cache/runtime/$team"
  test -d "$TEAM_HOME/data/$team/data"
  bash -c 'source "$1/core/lib/config.sh"; parse_team_config "$2"' bash "$ROOT" "$TEAM_HOME/config/$team/team-runtime.conf"
done

rm -rf "$TEAM_HOME/cache/runtime/best"
TEAM_RUNTIME_HEADLESS=1 OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEP_ROOT" "$ROOT/bin/opencode-team" best >"$TEST_ROOT/upgrade-start.out" 2>&1 &
upgrade_pid=$!
upgrade_ready=0
for _ in $(seq 1 30); do
  readiness="$(OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEP_ROOT" "$ROOT/bin/opencode-team" runtime-readiness 2>/dev/null || true)"
  if printf '%s' "$readiness" | jq -e '.ready == true' >/dev/null 2>&1; then upgrade_ready=1; break; fi
  if ! kill -0 "$upgrade_pid" 2>/dev/null; then break; fi
  sleep 1
done
if [ "$upgrade_ready" -ne 1 ]; then
  cat "$TEST_ROOT/upgrade-start.out" >&2
  kill "$upgrade_pid" 2>/dev/null || true
  wait "$upgrade_pid" 2>/dev/null || true
  exit 1
fi
kill "$upgrade_pid" 2>/dev/null || true
wait "$upgrade_pid" 2>/dev/null || true
printf '%s\n' 'UPGRADE SELF-HEAL START PASS'

TEAM_NAME=opencode-openai-daily OMO_PROFILE=openai-daily \
  OPENCODE_CONFIG="$TEAM_HOME/config/daily/opencode.jsonc" \
  OPENCODE_CONFIG_DIR="$TEAM_HOME/config/daily" \
  SANDBOX="$TEAM_HOME/data/daily" \
  XDG_CONFIG_HOME_OVERRIDE="$TEAM_HOME/config/daily/xdg-config" \
  XDG_DATA_HOME="$TEAM_HOME/data/daily/data" \
  XDG_STATE_HOME="$TEAM_HOME/state/daily" \
  PORT=0 bash -c 'source "$1/core/lib/core.sh"; export_env; test -z "${OMO_PROFILE+x}"' bash "$ROOT"
printf '%s\n' 'UPGRADE CONFIG PASS'

printf '%s\n' '{' >"$TEAM_HOME/config/daily/opencode.jsonc"
if OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEP_ROOT" "$ROOT/bin/opencode-team" doctor >/dev/null 2>&1; then
  printf '%s\n' 'doctor accepted an invalid DAILY config' >&2
  exit 1
fi
OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEP_ROOT" "$ROOT/bin/opencode-team" setup >/dev/null
mkdir -p "$TEAM_HOME/data/daily/state/team/work-packets"
printf '%s\n' '{"outcome":"completed","complexity":"TRIVIAL"}' >"$TEAM_HOME/data/daily/state/team/work-packets/0000000000000000000000000000000000000000000000000000000000000001.json"
report="$(OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEP_ROOT" "$ROOT/bin/opencode-team" daily-report)"
REPORT_JSON="$report" node -e 'const report = JSON.parse(process.env.REPORT_JSON); for (const field of ["completed_tasks", "estimated_total_usd", "cache_ratio_pct", "by_model", "by_complexity"]) if (!(field in report)) process.exit(1)'
REPORT_JSON="$report" node -e 'if (JSON.parse(process.env.REPORT_JSON).completed_tasks !== 1) process.exit(1)'
printf '%s\n' 'SETUP SMOKE PASS'
