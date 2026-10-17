#!/usr/bin/env bash
set -euo pipefail

package_root="${PACKAGE_ROOT:?PACKAGE_ROOT must be set}"
dependency_root="${DEPENDENCY_ROOT:?DEPENDENCY_ROOT must be set}"
python_bin="${PYTHON_BIN:?PYTHON_BIN must be set}"
scanner_root="$dependency_root/deep-audit/scanners"
node_root="$scanner_root/node"
tools="$scanner_root/bin"
marker="$scanner_root/.installed-lock-sha256"
jscpd_native_package=""
if [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ]; then
  jscpd_native_package=jscpd-darwin-arm64
fi
mkdir -p "$scanner_root" "$tools"
chmod 700 "$scanner_root" "$tools"

available_kb="$(df -Pk "$dependency_root" | awk 'NR==2 {print $4}')"
if [ "${available_kb:-0}" -lt 4194304 ]; then
  printf 'Deep Audit scanner install needs at least 4 GiB free in %s (currently %s KiB)\n' "$dependency_root" "${available_kb:-unknown}" >&2
  exit 1
fi

# Serena's TypeScript backend expects this exact directory/version pair. Install
# during profile setup, never from the target checkout or the user's npm cache.
# Keep this check ahead of the scanner marker fast path: existing installations
# must also acquire the language server when upgrading the audit profile.
serena_home="${DATA_ROOT:?DATA_ROOT must be set}/deep-audit/serena"
ts_root="$serena_home/language_servers/ts-lsp"
mkdir -p "$serena_home" "$serena_home/language_servers" "$ts_root"
chmod 700 "$serena_home" "$serena_home/language_servers" "$ts_root"
if [ ! -e "$serena_home/npmrc" ]; then (umask 077; : >"$serena_home/npmrc"); fi
export npm_config_cache="$serena_home/npm-cache"
export npm_config_userconfig="$serena_home/npmrc"
export npm_config_audit=false npm_config_fund=false
if ! "$python_bin" - "$ts_root" <<'PY'
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
expected = {"typescript": "5.9.3", "typescript-language-server": "5.1.3"}
for package, version in expected.items():
    manifest = root / "node_modules" / package / "package.json"
    try:
        if json.loads(manifest.read_text(encoding="utf-8"))["version"] != version:
            raise ValueError("wrong version")
    except (OSError, ValueError, KeyError):
        sys.exit(1)
if not (root / "node_modules" / ".bin" / "typescript-language-server").is_file():
    sys.exit(1)
PY
then
  npm install --prefix "$ts_root" --no-save --no-package-lock --ignore-scripts --no-audit --no-fund \
    'typescript@5.9.3' 'typescript-language-server@5.1.3'
fi

lock_hash="$(cat "$package_root/teams/deep-audit/scanners/package.json" "$package_root/teams/deep-audit/scanners/package-lock.json" "$package_root/teams/deep-audit/scanners/pyproject.toml" "$package_root/teams/deep-audit/scanners/uv.lock" "$package_root/teams/deep-audit/setup-scanners.sh" | shasum -a 256 | awk '{print $1}')"
if [ -f "$marker" ] && [ "$(<"$marker")" = "$lock_hash" ] \
  && [ -x "$node_root/node_modules/.bin/jscpd" ] \
  && [ -x "$node_root/node_modules/.bin/ast-grep" ] \
  && [ -x "$node_root/node_modules/.bin/knip" ] \
  && [ -x "$tools/gitleaks" ] && [ -x "$tools/osv-scanner" ] \
  && [ -x "$scanner_root/python/bin/semgrep" ] \
  && [ -x "$scanner_root/python/bin/bandit" ] \
  && [ -x "$scanner_root/python/bin/pip-audit" ] \
  && [ -x "$scanner_root/python/bin/pytest" ] \
  && [ -x "$scanner_root/python/bin/ruff" ] \
  && [ -x "$scanner_root/python/bin/sqlfluff" ] \
  && [ -x "$scanner_root/python/bin/vulture" ] \
  && { [ -z "$jscpd_native_package" ] || [ -f "$node_root/node_modules/$jscpd_native_package/package.json" ]; }; then
  printf 'Deep Audit scanners already installed from the pinned lock\n'
  exit 0
fi

mkdir -p "$node_root"
cp "$package_root/teams/deep-audit/scanners/package.json" "$node_root/package.json"
cp "$package_root/teams/deep-audit/scanners/package-lock.json" "$node_root/package-lock.json"
npm ci --include=optional --no-audit --no-fund --prefix "$node_root"
if [ -n "$jscpd_native_package" ] && [ ! -f "$node_root/node_modules/$jscpd_native_package/package.json" ]; then
  printf 'Deep Audit jscpd native package is missing: %s\n' "$jscpd_native_package" >&2
  exit 1
fi

UV_PROJECT_ENVIRONMENT="$scanner_root/python" \
UV_CACHE_DIR="$scanner_root/uv-cache" \
uv sync --project "$package_root/teams/deep-audit/scanners" --locked --no-install-project --python "$python_bin"

case "$(uname -m)" in
  arm64)
    gitleaks_asset=gitleaks_8.30.1_darwin_arm64.tar.gz
    gitleaks_sha=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5
    osv_asset=osv-scanner_darwin_arm64
    osv_sha=d4926ef8da134332543be276dff157e4c170f99ad91fc48e89448a8816bdf70b
    ;;
  x86_64)
    gitleaks_asset=gitleaks_8.30.1_darwin_x64.tar.gz
    gitleaks_sha=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709
    osv_asset=osv-scanner_darwin_amd64
    osv_sha=e82c5df7ab0a42dff29a1cd0660711447b56b4c0483ff66ad8634df10fd81a45
    ;;
  *) printf 'Unsupported Deep Audit scanner architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
esac

download_dir="$(mktemp -d "$scanner_root/.downloads.XXXXXX")"
trap 'rm -rf "$download_dir"' EXIT
curl -fsSL --proto '=https' --tlsv1.2 "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/$gitleaks_asset" -o "$download_dir/$gitleaks_asset"
printf '%s  %s\n' "$gitleaks_sha" "$download_dir/$gitleaks_asset" | shasum -a 256 -c -
mkdir "$download_dir/gitleaks"
tar -xzf "$download_dir/$gitleaks_asset" -C "$download_dir/gitleaks" gitleaks
curl -fsSL --proto '=https' --tlsv1.2 "https://github.com/google/osv-scanner/releases/download/v2.7.0/$osv_asset" -o "$download_dir/osv-scanner"
printf '%s  %s\n' "$osv_sha" "$download_dir/osv-scanner" | shasum -a 256 -c -
install -m 755 "$download_dir/gitleaks/gitleaks" "$tools/gitleaks"
install -m 755 "$download_dir/osv-scanner" "$tools/osv-scanner"

for executable in semgrep bandit pip-audit pytest ruff sqlfluff vulture; do
  [ -x "$scanner_root/python/bin/$executable" ] || { printf 'Deep Audit scanner missing after install: %s\n' "$executable" >&2; exit 1; }
done
for executable in jscpd ast-grep knip; do
  [ -x "$node_root/node_modules/.bin/$executable" ] || { printf 'Deep Audit scanner missing after npm install: %s\n' "$executable" >&2; exit 1; }
done

printf '%s\n' "$lock_hash" >"$marker"
chmod 600 "$marker"
printf 'Deep Audit scanners installed in profile-local storage: %s\n' "$scanner_root"
