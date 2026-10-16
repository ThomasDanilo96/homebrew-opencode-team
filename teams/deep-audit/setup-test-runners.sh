#!/usr/bin/env bash
set -euo pipefail

package_root="${PACKAGE_ROOT:?PACKAGE_ROOT must be set}"
dependency_root="${DEPENDENCY_ROOT:?DEPENDENCY_ROOT must be set}"
python_bin="${PYTHON_BIN:?PYTHON_BIN must be set}"
source_root="$package_root/teams/deep-audit/test-runners"
runtime_root="$dependency_root/deep-audit/test-runners"
images_file="$source_root/images.lock.json"
mkdir -p "$runtime_root" && chmod 700 "$runtime_root"

docker_bin="$(command -v docker 2>/dev/null || true)"
if [ -n "$docker_bin" ]; then
  docker_bin="$($python_bin -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$docker_bin")"
  case "$docker_bin" in
    /Applications/Docker.app/Contents/Resources/bin/*|/usr/local/bin/*|/usr/local/Cellar/*|/opt/homebrew/bin/*|/opt/homebrew/Cellar/*) ;;
    *) printf 'Deep Audit Docker CLI is outside trusted install paths: %s\n' "$docker_bin" >&2; exit 1 ;;
  esac
fi
if [ -z "$docker_bin" ] || ! "$docker_bin" info --format '{{.OSType}} {{.Architecture}}' >/dev/null 2>&1; then
  printf '%s\n' 'A running Docker Engine is required for isolated Deep Audit project tests; refusing host execution.' >&2
  exit 1
fi
operating_system="$("$docker_bin" info --format '{{.OperatingSystem}}')"
security_options="$("$docker_bin" info --format '{{json .SecurityOptions}}')"
if [ "$(uname -s)" = Darwin ]; then
  [ "$operating_system" = 'Docker Desktop' ] || { printf 'Deep Audit requires the Docker Desktop VM isolation boundary on macOS (got %s)\n' "$operating_system" >&2; exit 1; }
elif ! printf '%s' "$security_options" | rg -qi 'rootless|userns'; then
  printf '%s\n' 'Deep Audit requires rootless or userns-remapped Docker on Linux; refusing rootful daemon.' >&2
  exit 1
fi
docker_host="$("$docker_bin" context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)"
case "$docker_host" in
  unix://*) ;;
  *) printf 'Deep Audit requires a local Unix-socket Docker context; refusing remote engine: %s\n' "${docker_host:-unavailable}" >&2; exit 1 ;;
esac
case "$("$docker_bin" info --format '{{.Architecture}}')" in
  aarch64|arm64) platform=linux/arm64 ;;
  x86_64|amd64) platform=linux/amd64 ;;
  *) printf 'Unsupported Docker architecture for isolated tests: %s\n' "$("$docker_bin" info --format '{{.Architecture}}')" >&2; exit 1 ;;
esac

read_lock() {
  "$python_bin" - "$images_file" "$1" <<'PY'
import json, sys
value = json.load(open(sys.argv[1]))
for part in sys.argv[2].split("."):
    value = value[part]
print(value)
PY
}

node_image="$(read_lock node)"
python_base="$(read_lock python_base)"
php_base="$(read_lock php_base)"
phpunit_url="$(read_lock phpunit.url)"
phpunit_sha="$(read_lock phpunit.sha256)"
build_fingerprint="$($python_bin - "$source_root" <<'PY'
import hashlib, pathlib, sys
root = pathlib.Path(sys.argv[1])
names = ["images.lock.json", "python.Dockerfile", "php.Dockerfile", "python-requirements.txt"]
digest = hashlib.sha256()
for name in names:
    digest.update(name.encode())
    digest.update(b"\0")
    digest.update((root / name).read_bytes())
    digest.update(b"\0")
print(digest.hexdigest())
PY
)"
image_scope="$($python_bin - "$build_fingerprint" "$runtime_root" <<'PY'
import hashlib, pathlib, sys
print(f"{sys.argv[1][:12]}-{hashlib.sha256(str(pathlib.Path(sys.argv[2]).resolve()).encode()).hexdigest()[:10]}")
PY
)"
python_image="opencode-team/deep-audit-python:$image_scope"
php_image="opencode-team/deep-audit-php:$image_scope"

verify_installed_images() {
  [ -f "$runtime_root/images.json" ] || return 1
  "$python_bin" - "$runtime_root/images.json" "$node_image" "$python_image" "$php_image" "$build_fingerprint" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))
expected = {"node": sys.argv[2], "python": sys.argv[3], "php": sys.argv[4]}
if manifest.get("setup_fingerprint") not in (None, sys.argv[5]):
    raise SystemExit(1)
for name, reference in expected.items():
    if manifest.get(name, {}).get("reference") != reference or not manifest.get(name, {}).get("image_id", "").startswith("sha256:"):
        raise SystemExit(1)
PY
  for name in node python php; do
    image="$("$python_bin" - "$runtime_root/images.json" "$name" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))[sys.argv[2]]["image_id"])
PY
)"
    [ "$("$docker_bin" image inspect --format '{{.Id}}' "$image" 2>/dev/null || true)" = "$image" ] || return 1
  done
  "$docker_bin" run --rm --pull=never --network=none --read-only --cap-drop=ALL --security-opt=no-new-privileges:true --pids-limit=16 --memory=512m --user=65532:65532 --entrypoint /bin/sh "$node_image" -c 'node -e "process.exit(process.versions.node.startsWith(\"22.\") ? 0 : 1)" && npm --version >/dev/null' >/dev/null 2>&1 || return 1
  "$docker_bin" run --rm --pull=never --network=none --read-only --cap-drop=ALL --security-opt=no-new-privileges:true --pids-limit=16 --memory=512m --user=65532:65532 --entrypoint python "$python_image" -c 'import django, pytest, coverage, pytest_cov; assert django.get_version() == "5.2.8" and pytest.__version__ == "9.1.1" and coverage.__version__ == "7.16.2" and pytest_cov.__version__ == "7.1.0"' >/dev/null 2>&1 || return 1
  "$docker_bin" run --rm --pull=never --network=none --read-only --cap-drop=ALL --security-opt=no-new-privileges:true --pids-limit=16 --memory=512m --user=65532:65532 --entrypoint /bin/sh "$php_image" -c 'php -r "exit(PHP_MAJOR_VERSION === 8 && PHP_MINOR_VERSION === 4 ? 0 : 1);" && php /usr/local/bin/phpunit --version >/dev/null' >/dev/null 2>&1 || return 1
  "$python_bin" - "$runtime_root/images.json" "$build_fingerprint" <<'PY'
import json, os, pathlib, sys
path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text())
value["setup_fingerprint"] = sys.argv[2]
temporary = path.with_suffix(path.suffix + f".tmp.{os.getpid()}")
temporary.write_text(json.dumps(value, sort_keys=True) + "\n")
os.chmod(temporary, 0o600)
os.replace(temporary, path)
PY
  return 0
}

if verify_installed_images; then
  printf 'Pinned isolated Deep Audit runner images already installed and probed\n'
  exit 0
fi

for image in "$node_image" "$python_base" "$php_base"; do
  "$docker_bin" image inspect "$image" >/dev/null 2>&1 || "$docker_bin" pull --platform "$platform" "$image"
done

phpunit="$runtime_root/phpunit-13.4.2.phar"
if [ ! -f "$phpunit" ] || [ "$(shasum -a 256 "$phpunit" | awk '{print $1}')" != "$phpunit_sha" ]; then
  temporary="$phpunit.tmp.$$"
  trap 'rm -f "$temporary"' EXIT
  curl -fsSL --proto '=https' --tlsv1.2 "$phpunit_url" -o "$temporary"
  printf '%s  %s\n' "$phpunit_sha" "$temporary" | shasum -a 256 -c -
  chmod 600 "$temporary"
  mv "$temporary" "$phpunit"
fi

build_root="$runtime_root/build"
mkdir -p "$build_root"
cp "$source_root/python.Dockerfile" "$build_root/python.Dockerfile"
cp "$source_root/php.Dockerfile" "$build_root/php.Dockerfile"
cp "$source_root/python-requirements.txt" "$build_root/python-requirements.txt"
cp "$phpunit" "$build_root/phpunit-13.4.2.phar"
"$docker_bin" build --platform "$platform" --pull=false -f "$build_root/python.Dockerfile" -t "$python_image" "$build_root"
"$docker_bin" build --platform "$platform" --pull=false -f "$build_root/php.Dockerfile" -t "$php_image" "$build_root"

node_id="$("$docker_bin" image inspect --format '{{.Id}}' "$node_image")"
python_id="$("$docker_bin" image inspect --format '{{.Id}}' "$python_image")"
php_id="$("$docker_bin" image inspect --format '{{.Id}}' "$php_image")"
"$python_bin" - "$runtime_root/images.json" "$node_image" "$node_id" "$python_image" "$python_id" "$php_image" "$php_id" "$build_fingerprint" <<'PY'
import json, os, pathlib, sys
output, node_image, node_id, python_image, python_id, php_image, php_id, build_fingerprint = sys.argv[1:]
data = {
    "schema_version": 1,
    "setup_fingerprint": build_fingerprint,
    "node": {"reference": node_image, "image_id": node_id},
    "python": {"reference": python_image, "image_id": python_id},
    "php": {"reference": php_image, "image_id": php_id},
}
path = pathlib.Path(output)
temporary = path.with_suffix(path.suffix + f".tmp.{os.getpid()}")
temporary.write_text(json.dumps(data, sort_keys=True) + "\n")
os.chmod(temporary, 0o600)
os.replace(temporary, path)
PY

verify_image() {
  local image="$1" expected="$2"
  actual="$("$docker_bin" image inspect --format '{{.Id}}' "$image")"
  [ "$actual" = "$expected" ] || { printf 'Runner image changed during setup: %s\n' "$image" >&2; exit 1; }
}
verify_image "$node_image" "$node_id"
verify_image "$python_image" "$python_id"
verify_image "$php_image" "$php_id"
printf 'Isolated Deep Audit runner images ready (network disabled for test containers): %s\n' "$runtime_root/images.json"
