#!/usr/bin/env bash
set -euo pipefail

target="${DEEP_AUDIT_TARGET_ROOT:-}"
real_opencode="${DEEP_AUDIT_REAL_OPENCODE_BIN:-}"
sandbox_exec="/usr/bin/sandbox-exec"

[ -n "$target" ] && [ -d "$target" ] || { printf 'DEEP-AUDIT requires an existing target project directory\n' >&2; exit 2; }
[ -x "$real_opencode" ] || { printf 'DEEP-AUDIT OpenCode binary unavailable: %s\n' "$real_opencode" >&2; exit 2; }
[ -x "$sandbox_exec" ] || { printf 'DEEP-AUDIT requires macOS sandbox-exec; refusing an unsandboxed launch\n' >&2; exit 2; }

target="$(cd -P "$target" && pwd)"
case "$target" in
  /|/System|/System/*|/Library|/Library/*|/Users|/Users/*/Library|/Users/*/Library/*)
    printf 'Refusing a system-wide or private macOS directory as an audit target: %s\n' "$target" >&2
    exit 2
    ;;
esac

profile="${DEEP_AUDIT_SANDBOX_PROFILE:-${RUNTIME_ROOT:?RUNTIME_ROOT must be set}/readonly-project.sb}"
mkdir -p "$(dirname "$profile")"
"${OPENCODE_TEAM_PYTHON:?OPENCODE_TEAM_PYTHON must be set}" - "$target" "$profile" <<'PY'
import json
import os
import pathlib
import sys

target = pathlib.Path(sys.argv[1]).resolve(strict=True)
profile = pathlib.Path(sys.argv[2])
profile.parent.mkdir(parents=True, exist_ok=True)
home = pathlib.Path.home().resolve()
profile_data = pathlib.Path(os.environ.get("SANDBOX", "")).resolve()
profile_config = pathlib.Path(os.environ.get("OPENCODE_CONFIG_DIR", "")).resolve()
dependency_root = pathlib.Path(os.environ.get("DEEP_AUDIT_DEPENDENCY_ROOT", "")).resolve()
serena_bin = pathlib.Path(os.environ.get("DEEP_AUDIT_SERENA_BIN", "")).resolve()
allowed_writes = [
    os.environ.get("SANDBOX"),
    os.environ.get("OPENCODE_CONFIG_DIR"),
    os.environ.get("XDG_CONFIG_HOME"),
    os.environ.get("RUNTIME_ROOT"),
]
rules = ["(version 1)", "(allow default)", f"(deny file-write* (subpath {json.dumps(str(home))}))"]
if profile_data.is_absolute() and profile_data != pathlib.Path("/"):
    rules.extend((
        f"(deny file-write* (subpath {json.dumps(str(profile_data.parent))}))",
        f"(allow file-read* (subpath {json.dumps(str(profile_data))}))",
        f"(allow file-write* (subpath {json.dumps(str(profile_data))}))",
    ))
    for team in ("best", "best-ecc", "free", "go", "openai", "daily"):
        sibling = profile_data.parent / team
        rules.append(f"(deny file-read* (subpath {json.dumps(str(sibling))}))")
if profile_config.is_absolute() and profile_config != pathlib.Path("/"):
    rules.extend((
        f"(deny file-write* (subpath {json.dumps(str(profile_config.parent))}))",
        f"(allow file-read* (subpath {json.dumps(str(profile_config))}))",
        f"(allow file-write* (subpath {json.dumps(str(profile_config))}))",
    ))
    for team in ("best", "best-ecc", "free", "go", "openai", "daily"):
        sibling = profile_config.parent / team
        rules.append(f"(deny file-read* (subpath {json.dumps(str(sibling))}))")
if dependency_root.is_absolute() and dependency_root != pathlib.Path("/"):
    rules.append(f"(deny file-write* (subpath {json.dumps(str(dependency_root))}))")
    for relative in ("python", "best/node_modules", "deep-audit/scanners", "deep-audit/test-runners"):
        dependency = dependency_root / relative
        rules.append(f"(allow file-read* (subpath {json.dumps(str(dependency))}))")
if serena_bin.is_absolute() and serena_bin != pathlib.Path("/"):
    rules.append(f"(allow file-read* (subpath {json.dumps(str(serena_bin))}))")
for value in allowed_writes:
    if value:
        rules.append(f"(allow file-write* (subpath {json.dumps(str(pathlib.Path(value).resolve()))}))")
# Reviewer evidence is readable, but remains outside the project and read-only.
reports = pathlib.Path(os.environ.get("DEEP_AUDIT_REPORT_ROOT", "")).resolve()
if reports.is_absolute() and reports != pathlib.Path("/") and not reports.is_relative_to(target):
    rules.append(f"(allow file-read* (subpath {json.dumps(str(reports / 'test-runs'))}))")
    rules.append(f"(allow file-read* (subpath {json.dumps(str(reports / 'scanner-results'))}))")
for relative in (".ssh", ".aws", ".azure", ".gnupg", ".docker/config.json", ".kube/config", ".netrc", ".npmrc", ".pypirc", ".git-credentials", ".config/opencode", ".config/gh", ".config/gcloud", ".local/share/opencode", ".terraform.d/credentials.tfrc.json", ".vault-token", "Library/Keychains", "Library/Mail", "Library/Messages", "Library/Safari"):
    sensitive = home / relative
    rules.append(f"(deny file-read* (subpath {json.dumps(str(sensitive))}))")
    rules.append(f"(deny file-write* (subpath {json.dumps(str(sensitive))}))")
rules.append(f"(deny file-write* (subpath {json.dumps(str(target))}))")
text = "\n".join((*rules, ""))
tmp = profile.with_name(profile.name + f".tmp.{os.getpid()}")
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    with os.fdopen(fd, "w") as stream:
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, profile)
finally:
    try:
        tmp.unlink()
    except FileNotFoundError:
        pass
PY

exec "$sandbox_exec" -f "$profile" "$real_opencode" "$@"
