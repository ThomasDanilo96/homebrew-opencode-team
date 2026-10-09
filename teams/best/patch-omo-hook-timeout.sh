#!/usr/bin/env bash
set -euo pipefail

OMO="${1:-${BEST_OMO_PATCH_TARGET:-}}"
if [ -z "$OMO" ] && [ -n "${SANDBOX:-}" ]; then
BEST_DEPENDENCY_ROOT="${OPENCODE_TEAM_DEPENDENCY_ROOT:-$(cd "$SANDBOX/../dependencies" && pwd)}"
OMO="$BEST_DEPENDENCY_ROOT/best/node_modules/oh-my-openagent/dist/index.js"
fi
SUPPORTED_VERSIONS=("4.19.4" "5.1.27")
UNPATCHED_SIGNATURE='options.pluginRoot = cmdHook.pluginRoot;'
PATCHED_SIGNATURE='typeof cmdHook.timeout === "number"'

log() { printf '[hook-timeout-patch] %s\n' "$1"; }
[ -n "$OMO" ] && [ -f "$OMO" ] || { log "REFUSED: OMO target missing" >&2; exit 1; }

package_json="$(cd "$(dirname "$OMO")/.." && pwd)/package.json"
version="$(node -p "require('$package_json').version")"
case " ${SUPPORTED_VERSIONS[*]} " in
  *" $version "*) ;;
  *) log "REFUSED: unsupported oh-my-openagent version $version" >&2; exit 1 ;;
esac

if rg -q "$PATCHED_SIGNATURE" "$OMO"; then
  log "ALREADY_PATCHED: $OMO"
  exit 0
fi
rg -q "$UNPATCHED_SIGNATURE" "$OMO" || { log "REFUSED: unpatched signature missing" >&2; exit 1; }

"${OPENCODE_TEAM_PYTHON:?OPENCODE_TEAM_PYTHON is required}" - "$OMO" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()
old = "  if (cmdHook.pluginRoot) {\n    options.pluginRoot = cmdHook.pluginRoot;\n  }\n  return executeHookCommand(hook.command, stdinJson, cwd, options);"
new = "  if (cmdHook.pluginRoot) {\n    options.pluginRoot = cmdHook.pluginRoot;\n  }\n  if (typeof cmdHook.timeout === \"number\" && Number.isFinite(cmdHook.timeout) && cmdHook.timeout > 0) {\n    options.timeoutMs = cmdHook.timeout * 1000;\n  }\n  return executeHookCommand(hook.command, stdinJson, cwd, options);"
if text.count(old) != 1:
    raise SystemExit(f"REFUSED: pattern matched {text.count(old)} times")
path.write_text(text.replace(old, new, 1))
PY

node --check "$OMO"
rg -q "$PATCHED_SIGNATURE" "$OMO"
log "PATCHED: $OMO"
