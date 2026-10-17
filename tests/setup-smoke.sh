#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENCODE_TEAM_PACKAGE_ROOT:-$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
if [ -x /opt/homebrew/opt/node@22/bin/node ]; then
  PATH="/opt/homebrew/opt/node@22/bin:$PATH"
  export PATH
fi
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/opencode-team-setup.XXXXXX")"
TEAM_HOME="$TEST_ROOT/home-a"
SECOND_TEAM_HOME="$TEST_ROOT/home-b"
DEP_ROOT="${OPENCODE_TEAM_TEST_DEPENDENCY_ROOT:-${TMPDIR:-/tmp}/opencode-team-setup-dependencies-${USER:-$(id -u)}}"

cleanup_setup_smoke() {
  local status=$? cleanup_failed=0 path pid image_ref
  local -a cleanup_pids=()
  trap - EXIT HUP INT TERM
  printf 'SETUP SMOKE CLEANUP START test_root=%s\n' "$TEST_ROOT" >&2
  case "$DEP_ROOT" in
    "$TEST_ROOT"/*)
      local runner_images="$DEP_ROOT/deep-audit/test-runners/images.json"
      if [ -f "$runner_images" ] && command -v docker >/dev/null 2>&1; then
        while IFS= read -r image_ref; do
          case "$image_ref" in
            opencode-team/deep-audit-python:*|opencode-team/deep-audit-php:*)
              docker image rm "$image_ref" >/dev/null 2>&1 || cleanup_failed=1
              ;;
          esac
        done < <(jq -r '[.python.reference, .php.reference][]' "$runner_images")
      fi
      ;;
  esac
  for path in "$TEAM_HOME" "$SECOND_TEAM_HOME" "$TEST_ROOT/root-isolation-home"; do
    if [ -e "$path" ]; then
      rm -rf -- "$path" &
      cleanup_pids+=("$!")
    fi
  done
  case "$DEP_ROOT" in
    "$TEST_ROOT"/*)
      for path in "$DEP_ROOT"/* "$DEP_ROOT"/.[!.]* "$DEP_ROOT"/..?*; do
        [ -e "$path" ] || continue
        rm -rf -- "$path" &
        cleanup_pids+=("$!")
      done
      ;;
    *)
      printf 'SETUP SMOKE DEPENDENCY CACHE PRESERVED path=%s\n' "$DEP_ROOT" >&2
      ;;
  esac
  for pid in "${cleanup_pids[@]}"; do
    wait "$pid" || cleanup_failed=1
  done
  rm -rf -- "$TEST_ROOT" || cleanup_failed=1
  printf 'SETUP SMOKE CLEANUP COMPLETE status=%s cleanup_failed=%s\n' "$status" "$cleanup_failed" >&2
  [ "$cleanup_failed" -eq 0 ] || return 1
  return "$status"
}

trap cleanup_setup_smoke EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
(umask 077; : >"$TEST_ROOT/npmrc")
export npm_config_userconfig="$TEST_ROOT/npmrc"
npm_config_cache="$TEST_ROOT/npm-cache"
export npm_config_cache

shared_bytes() {
  [ -d "$DEP_ROOT" ] || { printf '%s\n' 0; return; }
  du -sk "$DEP_ROOT" | awk '{print $1 * 1024}'
}

shared_before_bytes="$(shared_bytes)"

node --test "$ROOT/tests/opencode-team-launcher-regression.test.mjs"

OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEP_ROOT" "$ROOT/bin/opencode-team" setup >"$TEST_ROOT/setup-first.out"
OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_PACKAGE_ROOT="$ROOT" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEP_ROOT" \
  "$ROOT/tests/config-parity.sh"
bash "$ROOT/tests/zsh-completion.test.sh"
first_shared_bytes="$(shared_bytes)"
TUI_FILES=()
for template in "$ROOT"/teams/*/tui.json.template; do
  team="$(basename "$(dirname "$template")")"
  tui_file="$TEAM_HOME/config/$team/xdg-config/opencode/tui.json"
  TUI_FILES+=("$tui_file")
done
for team in best best-ecc deep-audit free go openai daily; do
  test -f "$TEAM_HOME/config/$team/team-runtime.conf"
  test -f "$TEAM_HOME/config/$team/opencode.jsonc"
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$TEAM_HOME/config/$team/opencode.jsonc"
done
test -f "$TEAM_HOME/config/best-ecc/claude-config/settings.json"
test -f "$TEAM_HOME/data/best-ecc/ecc/.opencode/plugins/ecc-hooks.ts"
test -f "$TEAM_HOME/data/deep-audit/ecc/skills/security-review/SKILL.md"
deep_audit_config_root="$TEAM_HOME/config/deep-audit"
node - "$deep_audit_config_root" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const configRoot = process.argv[2];
const pluginEntry = path.join(configRoot, "node_modules/@opencode-ai/plugin/dist/tool.js");
if (!fs.existsSync(pluginEntry)) {
  throw new Error(`Deep Audit plugin entry is missing from its config root: ${pluginEntry}`);
}
if (pluginEntry.includes("/config/best/")) throw new Error(`Deep Audit plugin path escaped into BEST: ${pluginEntry}`);
NODE
serena_npmrc="$TEAM_HOME/data/deep-audit/serena/npmrc"
test -f "$serena_npmrc"
test "$(stat -f '%Lp' "$serena_npmrc")" = 600
if [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ]; then
  test -f "$DEP_ROOT/deep-audit/scanners/node/node_modules/jscpd-darwin-arm64/package.json"
  node - "$DEP_ROOT/deep-audit/scanners/node/node_modules/jscpd-darwin-arm64/package.json" <<'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (manifest.version !== "5.4.1") throw new Error(`Unexpected jscpd-darwin-arm64 version: ${manifest.version}`);
NODE
fi
for tui_file in "${TUI_FILES[@]}"; do
  test -f "$tui_file"
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$tui_file"
done

CONFIG_FILES=("$TEAM_HOME"/config/*/{team-runtime.conf,opencode.jsonc})
before="$(shasum -a 256 "${CONFIG_FILES[@]}" "${TUI_FILES[@]}")"
OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEP_ROOT" OPENCODE_TEAM_TEST_SKIP_ECC_SETUP=1 \
  "$ROOT/bin/opencode-team" setup >"$TEST_ROOT/setup-idempotency.out"
after="$(shasum -a 256 "${CONFIG_FILES[@]}" "${TUI_FILES[@]}")"
test "$before" = "$after"

second_before_bytes="$(shared_bytes)"
OPENCODE_TEAM_HOME="$SECOND_TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEP_ROOT" \
  "$ROOT/bin/opencode-team" setup >"$TEST_ROOT/setup-second-home.out"
second_after_bytes="$(shared_bytes)"
test -d "$DEP_ROOT/best/node_modules/oh-my-openagent"
test -f "$TEAM_HOME/config/free/opencode.jsonc"
test "$(grep -c 'step-5-preview-free' "$TEAM_HOME/config/free/opencode.jsonc")" -eq 1
test -d "$DEP_ROOT/go/node_modules/oh-my-openagent"
test -d "$DEP_ROOT/openai/node_modules/oh-my-openagent"
test -x "$DEP_ROOT/bin/serena"
if find "$SECOND_TEAM_HOME" -path '*/node_modules/oh-my-openagent' -print -quit | rg -q .; then
  printf '%s\n' 'second isolated home duplicated OMO dependency tree' >&2
  exit 1
fi
expected_plugin_cache="$SECOND_TEAM_HOME/config/deep-audit/node_modules"
expected_xdg_plugin_cache="$SECOND_TEAM_HOME/config/deep-audit/xdg-config/opencode/node_modules"
expected_ts_server_modules="$SECOND_TEAM_HOME/data/deep-audit/serena/language_servers/ts-lsp/node_modules"
test -f "$expected_plugin_cache/@opencode-ai/plugin/package.json"
test -f "$expected_xdg_plugin_cache/@opencode-ai/plugin/package.json"
node - "$expected_ts_server_modules" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
for (const [name, version] of [["typescript", "5.9.3"], ["typescript-language-server", "5.1.3"]]) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, name, "package.json"), "utf8"));
  if (manifest.version !== version) throw new Error(`${name} version mismatch: ${manifest.version}`);
}
if (!fs.existsSync(path.join(root, ".bin", "typescript-language-server"))) throw new Error("TypeScript language-server executable missing");
NODE
while IFS= read -r node_modules_dir; do
  case "$node_modules_dir" in
    "$expected_plugin_cache"|"$expected_xdg_plugin_cache"|"$expected_ts_server_modules") ;;
    *) printf 'unexpected profile-local node_modules tree: %s\n' "$node_modules_dir" >&2; exit 1 ;;
  esac
done < <(find "$SECOND_TEAM_HOME" -type d -name node_modules -prune -print)
shared_dependency_bytes="$(du -sk "$DEP_ROOT" | awk '{print $1 * 1024}')"
second_home_plugin_cache_bytes="$(du -sk "$expected_plugin_cache" "$expected_xdg_plugin_cache" | awk '{sum += $1 * 1024} END {print sum + 0}')"
first_setup_dependency_bytes="$((first_shared_bytes - shared_before_bytes))"
second_setup_dependency_bytes="$((second_after_bytes - second_before_bytes))"
printf 'shared_dependency_bytes=%s\nfirst_setup_dependency_bytes=%s\nsecond_setup_dependency_bytes=%s\nsecond_home_profile_plugin_cache_bytes=%s\n' "$shared_dependency_bytes" "$first_setup_dependency_bytes" "$second_setup_dependency_bytes" "$second_home_plugin_cache_bytes" >"$TEST_ROOT/dependency-sharing-evidence.txt"
test "$shared_dependency_bytes" -gt 0
# A persistent isolated test cache may already be warm; its current bytes and
# the second-home no-growth check prove sharing without requiring a redownload.
test "$first_setup_dependency_bytes" -ge 0
test "$second_home_plugin_cache_bytes" -gt 0
test "$second_setup_dependency_bytes" -le 0

OLD_ROOT="$TEST_ROOT/version-a/brew-opencode-team/libexec"
node - "$TEAM_HOME/config" "$ROOT" "$OLD_ROOT" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [configRoot, currentRoot, oldRoot] = process.argv.slice(2);
for (const team of ["best", "best-ecc", "deep-audit", "free", "go", "openai", "daily"]) {
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

for team in best best-ecc deep-audit free go openai daily; do
  rm -rf "$TEAM_HOME/cache/runtime/$team" "$TEAM_HOME/data/$team/data"
done

if ! OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEP_ROOT" \
  "$ROOT/bin/opencode-team" doctor >"$TEST_ROOT/setup-upgrade-doctor.out" 2>&1; then
  cat "$TEST_ROOT/setup-upgrade-doctor.out" >&2
  exit 1
fi
if ! rg -q 'Runtime tool state[[:space:]]+VERIFIED .*Serena MCP connected/read-only call executed; no model request' "$TEST_ROOT/setup-upgrade-doctor.out"; then
  cat "$TEST_ROOT/setup-upgrade-doctor.out" >&2
  printf '%s\n' 'Deep Audit plugin/Serena preflight did not reach VERIFIED' >&2
  exit 1
fi
if ! rg -q 'Deep Audit auth[[:space:]]+REQUIRED' "$TEST_ROOT/setup-upgrade-doctor.out"; then
  cat "$TEST_ROOT/setup-upgrade-doctor.out" >&2
  printf '%s\n' 'Clean smoke profile unexpectedly has no separate OAuth-required status' >&2
  exit 1
fi
! rg -q '/Cellar/opencode-team/[0-9]' "$TEAM_HOME/config"
! rg -q "$OLD_ROOT" "$TEAM_HOME/config"
for team in best best-ecc deep-audit free go openai daily; do
  test -d "$TEAM_HOME/cache/runtime/$team"
  test -d "$TEAM_HOME/data/$team/data"
  bash -c 'source "$1/core/lib/config.sh"; parse_team_config "$2"' bash "$ROOT" "$TEAM_HOME/config/$team/team-runtime.conf"
done

rm -rf "$TEAM_HOME/cache/runtime/best"
TEAM_RUNTIME_HEADLESS=1 OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEP_ROOT" "$ROOT/bin/opencode-team" best >"$TEST_ROOT/upgrade-start.out" 2>&1 &
upgrade_pid=$!
upgrade_ready=0
upgrade_run_rel=""
for _ in $(seq 1 30); do
  readiness="$(OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEP_ROOT" "$ROOT/bin/opencode-team" runtime-readiness 2>/dev/null || true)"
  if printf '%s' "$readiness" | jq -e '.ready == true and ([.runs[] | select(.ready == true)] | length) == 1' >/dev/null 2>&1; then
    upgrade_ready=1
    upgrade_run_rel="$(printf '%s' "$readiness" | jq -r '.runs[] | select(.ready == true) | .run')"
    break
  fi
  if ! kill -0 "$upgrade_pid" 2>/dev/null; then break; fi
  sleep 1
done
if [ "$upgrade_ready" -ne 1 ]; then
  cat "$TEST_ROOT/upgrade-start.out" >&2
  kill "$upgrade_pid" 2>/dev/null || true
  wait "$upgrade_pid" 2>/dev/null || true
  exit 1
fi
case "$upgrade_run_rel" in best/runs/[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]) ;; *) printf 'invalid readiness run path: %s\n' "$upgrade_run_rel" >&2; exit 1 ;; esac
upgrade_run_dir="$TEAM_HOME/cache/runtime/$upgrade_run_rel"
test -d "$upgrade_run_dir"
upgrade_identity_pids=""
for role in launcher server bridge attach watchdog reaper; do
  identity_file="$upgrade_run_dir/$role.identity"
  if [ -f "$identity_file" ]; then
    upgrade_identity_pids="$upgrade_identity_pids $(sed -n 's/^pid=//p' "$identity_file")"
  fi
done
test "$(sed -n 's/^pid=//p' "$upgrade_run_dir/launcher.identity")" = "$upgrade_pid"
kill -TERM "$upgrade_pid"
wait "$upgrade_pid" 2>/dev/null || true
for _ in $(seq 1 30); do
  identities_alive=0
  for pid in $upgrade_identity_pids; do
    if kill -0 "$pid" 2>/dev/null; then identities_alive=1; fi
  done
  if [ "$identities_alive" -eq 0 ] && [ ! -e "$upgrade_run_dir" ]; then break; fi
  sleep 1
done
for pid in $upgrade_identity_pids; do
  if kill -0 "$pid" 2>/dev/null; then
    printf 'controlled runtime identity survived SIGTERM: %s\n' "$pid" >&2
    exit 1
  fi
done
if [ -e "$upgrade_run_dir" ]; then
  printf 'runtime state remained after self-heal shutdown: %s\n' "$upgrade_run_dir" >&2
  for state_file in state status stage failure_reason; do
    if [ -f "$upgrade_run_dir/$state_file" ]; then
      printf '%s: ' "$state_file" >&2
      tr '\n' ' ' < "$upgrade_run_dir/$state_file" >&2
      printf '\n' >&2
    fi
  done
  node "$ROOT/core/lib/runtime-manifest.mjs" "$upgrade_run_dir" status >&2 || true
  ps -axo pid=,command= | rg "$TEAM_HOME" | rg -v 'rg ' >&2 || true
  cat "$TEST_ROOT/upgrade-start.out" >&2
  exit 1
fi
post_readiness="$(OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEP_ROOT" "$ROOT/bin/opencode-team" runtime-readiness)"
printf '%s' "$post_readiness" | jq -e --arg run "$upgrade_run_rel" '[.runs[] | select(.run == $run)] | length == 0' >/dev/null
printf '%s\n' 'UPGRADE SELF-HEAL START PASS'

TEAM_NAME=opencode-openai-daily OMO_PROFILE=openai-daily BRIDGE_MODE=native_ui \
  OPENCODE_CONFIG="$TEAM_HOME/config/daily/opencode.jsonc" \
  OPENCODE_CONFIG_DIR="$TEAM_HOME/config/daily" \
  SANDBOX="$TEAM_HOME/data/daily" \
  XDG_CONFIG_HOME_OVERRIDE="$TEAM_HOME/config/daily/xdg-config" \
  XDG_DATA_HOME="$TEAM_HOME/data/daily/data" \
  XDG_STATE_HOME="$TEAM_HOME/state/daily" \
  PORT=0 bash -c 'source "$1/core/lib/core.sh"; export_env; test -z "${OMO_PROFILE+x}"' bash "$ROOT"
printf '%s\n' 'UPGRADE CONFIG PASS'

printf '%s\n' '{' >"$TEAM_HOME/config/daily/opencode.jsonc"
if ! HOME="$HOME" OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEP_ROOT" \
  "$ROOT/bin/opencode-team" doctor >"$TEST_ROOT/daily-config-self-heal.out" 2>&1; then
  cat "$TEST_ROOT/daily-config-self-heal.out" >&2
  printf '%s\n' 'doctor failed to repair the invalid generated DAILY config' >&2
  exit 1
fi
node - "$TEAM_HOME/config/daily/opencode.jsonc" <<'NODE'
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (config.model !== "openai/gpt-6-luna") throw new Error("DAILY config was not restored from its generated profile template");
NODE
mkdir -p "$TEAM_HOME/data/daily/state/team/work-packets"
printf '%s\n' '{"outcome":"completed","complexity":"TRIVIAL"}' >"$TEAM_HOME/data/daily/state/team/work-packets/0000000000000000000000000000000000000000000000000000000000000001.json"
report="$(OPENCODE_TEAM_HOME="$TEAM_HOME" OPENCODE_TEAM_DEPENDENCY_ROOT="$DEP_ROOT" "$ROOT/bin/opencode-team" daily-report)"
REPORT_JSON="$report" node -e 'const report = JSON.parse(process.env.REPORT_JSON); for (const field of ["completed_tasks", "estimated_total_usd", "cache_ratio_pct", "by_model", "by_complexity"]) if (!(field in report)) process.exit(1)'
REPORT_JSON="$report" node -e 'if (JSON.parse(process.env.REPORT_JSON).completed_tasks !== 1) process.exit(1)'
printf '%s\n' 'SETUP SMOKE PASS'
