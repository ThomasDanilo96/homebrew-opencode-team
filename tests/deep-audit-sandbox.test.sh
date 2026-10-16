#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="${OPENCODE_TEAM_PYTHON:-$(command -v python3)}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/deep-audit-sandbox-test.XXXXXX")"
TMP="$(cd -P "$TMP" && pwd)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/project" "$TMP/reports" "$TMP/cache" "$TMP/home/.ssh" "$TMP/home/.docker" "$TMP/home/.config/opencode" "$TMP/home/.config/gh" "$TMP/home/.local/share/opencode" "$TMP/home/profile-data/reports" "$TMP/home/profile-data/data/opencode" "$TMP/home/profile-runtime" "$TMP/home/best/data/opencode" "$TMP/config/profile-config-dir" "$TMP/config/profile-config"
printf '%s\n' 'fixture-private-key-material' >"$TMP/home/.ssh/id_ed25519"
printf '%s\n' '{"auths":{"registry.example.invalid":{"auth":"fixture"}}}' >"$TMP/home/.docker/config.json"
printf '%s\n' 'other-profile-oauth-token' >"$TMP/home/.config/opencode/auth.json"
printf '%s\n' 'fixture-github-token' >"$TMP/home/.config/gh/hosts.yml"
printf '%s\n' 'shared-opencode-oauth-token' >"$TMP/home/.local/share/opencode/auth.json"
printf '%s\n' 'other-team-oauth-token' >"$TMP/home/best/data/opencode/auth.json"
export DEEP_AUDIT_TARGET_ROOT="$TMP/project"
export DEEP_AUDIT_REAL_OPENCODE_BIN=/usr/bin/touch
export DEEP_AUDIT_SANDBOX_PROFILE="$TMP/cache/readonly.sb"
export HOME="$TMP/home"
export SANDBOX="$TMP/home/profile-data"
export XDG_CONFIG_HOME="$TMP/config/profile-config"
export OPENCODE_CONFIG_DIR="$TMP/config/profile-config-dir"
export RUNTIME_ROOT="$TMP/home/profile-runtime"
export OPENCODE_TEAM_PYTHON="$PYTHON"

if "$ROOT/teams/deep-audit/bin/read-only-opencode.sh" "$TMP/project/forbidden" >/dev/null 2>&1; then
  printf 'sandbox unexpectedly allowed a project write\n' >&2
  exit 1
fi
test ! -e "$TMP/project/forbidden"
"$ROOT/teams/deep-audit/bin/read-only-opencode.sh" "$TMP/reports/allowed" >/dev/null
test -f "$TMP/reports/allowed"
"$ROOT/teams/deep-audit/bin/read-only-opencode.sh" "$TMP/home/profile-data/reports/profile-report" >/dev/null
test -f "$TMP/home/profile-data/reports/profile-report"
"$ROOT/teams/deep-audit/bin/read-only-opencode.sh" "$TMP/home/profile-data/data/opencode/auth.json" >/dev/null
test -f "$TMP/home/profile-data/data/opencode/auth.json"
"$ROOT/teams/deep-audit/bin/read-only-opencode.sh" "$TMP/config/profile-config-dir/plugin-cache" >/dev/null
test -f "$TMP/config/profile-config-dir/plugin-cache"
for secret in "$TMP/home/.ssh/id_ed25519" "$TMP/home/.docker/config.json" "$TMP/home/.config/opencode/auth.json" "$TMP/home/.config/gh/hosts.yml" "$TMP/home/.local/share/opencode/auth.json" "$TMP/home/best/data/opencode/auth.json"; do
  if DEEP_AUDIT_REAL_OPENCODE_BIN=/bin/cat "$ROOT/teams/deep-audit/bin/read-only-opencode.sh" "$secret" >/dev/null 2>&1; then
    printf 'sandbox unexpectedly read sensitive host path: %s\n' "$secret" >&2
    exit 1
  fi
done
if "$ROOT/teams/deep-audit/bin/read-only-opencode.sh" "$TMP/home/unapproved-write" >/dev/null 2>&1; then
  printf '%s\n' 'sandbox unexpectedly allowed an unapproved home write' >&2
  exit 1
fi
test ! -e "$TMP/home/unapproved-write"
printf 'DEEP_AUDIT_SANDBOX PASS\n'
