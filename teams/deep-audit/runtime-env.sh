#!/usr/bin/env bash
# Sourced by the launcher; no project writes, model remapping or fallback.
export OPENCODE_DISABLE_EXTERNAL_SKILLS=1
export OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1
export OPENCODE_DISABLE_PROJECT_CONFIG=1
# Serena defaults to ~/.serena, which is outside the audit profile and is
# protected by the host sandbox. Keep its config, caches and logs profile-local.
export SERENA_HOME="$SANDBOX/serena"
# Language-server packages are installed only in Serena's profile-owned cache;
# never let npm use the user's potentially read-only/shared ~/.npm cache.
export npm_config_cache="$SERENA_HOME/npm-cache"
if [ ! -e "$SERENA_HOME/npmrc" ]; then (umask 077; : >"$SERENA_HOME/npmrc"); fi
export npm_config_userconfig="$SERENA_HOME/npmrc"
export npm_config_audit=false
export npm_config_fund=false
# --pure / OPENCODE_PURE disables even explicitly configured local plugins.
# The audit needs its three profile-owned tools; never inherit this switch.
unset OPENCODE_PURE
export OMO_DISABLE_POSTHOG=1
export OMO_SEND_ANONYMOUS_TELEMETRY=0

DEEP_AUDIT_PACKAGE_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export DEEP_AUDIT_TARGET_ROOT="${DEEP_AUDIT_TARGET_ROOT:?Deep Audit target directory is required}"
export DEEP_AUDIT_REAL_OPENCODE_BIN="${OPENCODE_BIN:?OPENCODE_BIN must be set}"
export DEEP_AUDIT_SANDBOX_PROFILE="$RUNTIME_ROOT/readonly-project.sb"
"${OPENCODE_TEAM_PYTHON:?OPENCODE_TEAM_PYTHON must be set}" - "$SERENA_HOME/serena_config.yml" "$SERENA_HOME" "$DEEP_AUDIT_TARGET_ROOT" <<'PY'
import json
import os
import pathlib

config_path = pathlib.Path(os.path.abspath(__import__("sys").argv[1]))
serena_home = pathlib.Path(os.path.realpath(__import__("sys").argv[2]))
target = pathlib.Path(__import__("sys").argv[3]).resolve(strict=True)
if not target.is_dir():
    raise SystemExit("Deep Audit target must be a directory before Serena initialization")
project_data = serena_home / "projects" / target.name / ".serena"
project_data.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(project_data.parent, 0o700)
os.chmod(project_data, 0o700)

skip = {".git", ".hg", ".svn", "node_modules", "vendor", ".venv", "venv", "__pycache__", "dist", "build", "target"}
extensions = set()
for root, dirs, files in os.walk(target, followlinks=False):
    dirs[:] = [name for name in dirs if name not in skip and not (pathlib.Path(root) / name).is_symlink()]
    for name in files:
        if not (pathlib.Path(root) / name).is_symlink():
            extensions.add(pathlib.Path(name).suffix.lower())
languages = []
if extensions & {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"}:
    languages.append("typescript")
if extensions & {".py", ".pyi"}:
    languages.append("python")
quoted_target = json.dumps(str(target))
quoted_project_store = json.dumps(str(serena_home / "projects" / "$projectFolderName" / ".serena"))
global_yaml = (
    "language_backend: LSP\n"
    f"projects:\n  - {quoted_target}\n"
    f"project_serena_folder_location: {quoted_project_store}\n"
    f"trusted_project_path_patterns:\n  - {quoted_target}\n"
    "ls_specific_settings:\n"
    "  typescript:\n"
    "    typescript_version: \"5.9.3\"\n"
    "    typescript_language_server_version: \"5.1.3\"\n"
)
# Serena only loads project.local.yml when a project.yml already exists. Without
# the latter, --project-from-cwd autogenerates a project and can ignore our
# explicit TypeScript selection on its first activation. Both files live in
# profile storage; neither is written into the audited tree.
project_yaml = (
    f"project_name: {json.dumps(target.name)}\n"
    "language_servers: [" + ", ".join(json.dumps(name) for name in languages) + "]\n"
    "read_only: true\n"
)
local_yaml = "language_servers: [" + ", ".join(json.dumps(name) for name in languages) + "]\n"
if "typescript" in languages:
    local_yaml += "ls_specific_settings:\n  typescript:\n    typescript_version: \"5.9.3\"\n    typescript_language_server_version: \"5.1.3\"\n"

def atomic_private_write(destination, content):
    temporary = destination.with_name(destination.name + f".tmp.{os.getpid()}")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass

atomic_private_write(config_path, global_yaml)
atomic_private_write(project_data / "project.yml", project_yaml)
atomic_private_write(project_data / "project.local.yml", local_yaml)
PY
export npm_config_cache="$SERENA_HOME/npm-cache"
export npm_config_audit=false
export npm_config_fund=false
if [ -n "${OPENCODE_TEAM_DEPENDENCY_ROOT:-}" ]; then
  DEEP_AUDIT_DEPENDENCY_ROOT="$OPENCODE_TEAM_DEPENDENCY_ROOT"
else
  DEEP_AUDIT_DEPENDENCY_ROOT="$(cd -P "$SANDBOX/../dependencies" && pwd)"
fi
export DEEP_AUDIT_SCANNER_ROOT="$DEEP_AUDIT_DEPENDENCY_ROOT/deep-audit/scanners"
DEEP_AUDIT_NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -n "$DEEP_AUDIT_NODE_BIN" ] && [ -x "$DEEP_AUDIT_NODE_BIN" ]; then
  export DEEP_AUDIT_NODE_BIN
else
  unset DEEP_AUDIT_NODE_BIN
fi
export DEEP_AUDIT_TEST_RUNNER_ROOT="$DEEP_AUDIT_DEPENDENCY_ROOT/deep-audit/test-runners"
export DEEP_AUDIT_TEST_RUNNER_IMAGES="$DEEP_AUDIT_TEST_RUNNER_ROOT/images.json"
export DEEP_AUDIT_DOCKER_BIN="$(command -v docker || true)"
export DEEP_AUDIT_RULES_ROOT="$DEEP_AUDIT_PACKAGE_ROOT/teams/deep-audit/rules"
if [ -x "$DEEP_AUDIT_DEPENDENCY_ROOT/bin/serena" ]; then
  export DEEP_AUDIT_SERENA_BIN="$DEEP_AUDIT_DEPENDENCY_ROOT/bin/serena"
else
  export DEEP_AUDIT_SERENA_BIN="$SANDBOX/../bin/serena"
fi
export PATH="$DEEP_AUDIT_SCANNER_ROOT/bin:$DEEP_AUDIT_SCANNER_ROOT/python/bin:$DEEP_AUDIT_SCANNER_ROOT/node/node_modules/.bin:$PATH"
export OPENCODE_BIN="$DEEP_AUDIT_PACKAGE_ROOT/teams/deep-audit/bin/read-only-opencode.sh"
export DEEP_AUDIT_REPORT_ROOT="$SANDBOX/reports"
export DEEP_AUDIT_SCANNER_TMP_ROOT="$DEEP_AUDIT_REPORT_ROOT/.scanner-work"
# Trusted host runtime utilities required by profile-installed scanners.
export DEEP_AUDIT_SYSTEM_BIN="/usr/bin:/bin"
