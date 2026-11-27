#!/usr/bin/env bash
# Release-builder only: never run from Formula#install.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
target="${1:?usage: build-team-runtime.sh TARGET NEW_OUTPUT_DIRECTORY}"
output="${2:?usage: build-team-runtime.sh TARGET NEW_OUTPUT_DIRECTORY}"
case "$target" in
  darwin-arm64|linux-arm64|linux-x64-baseline) ;;
  *) echo "Unsupported Homebrew runtime target: $target" >&2; exit 2 ;;
esac
[[ "$(bun --version)" == 1.4.4 ]]
mkdir "$output"
output="$(cd "$output" && pwd -P)"
upstream=c0ad18b402eb2827fc1ee71c171b1177b3fc02d1
version=2.3.2
source_sha=cb6486bf0e8a5fb49b5367beca7685e45f311bfe2a38b2ad15c6a3e3bdcf8bc9
patch="$root/patches/opencode-v$version-tui-prompt-admission.patch"
curl --fail --silent --show-error --location --proto '=https' --max-time 180 \
  "https://codeload.github.com/anomalyco/opencode/tar.gz/$upstream" -o "$output/source.tar.gz"
(cd "$output" && printf '%s  source.tar.gz\n' "$source_sha" | shasum -a 256 -c -)
mkdir "$output/source"
tar -xzf "$output/source.tar.gz" --strip-components=1 -C "$output/source"
cd "$output/source"
git apply --check "$patch"
git apply "$patch"
bun install --frozen-lockfile --linker hoisted
OPENCODE_VERSION="$version" OPENCODE_TARGET="$target" bun run --cwd packages/cli build \
  --skip-install --outdir="$output/build"
python3 - "$output" "$target" "$version" "$upstream" "$patch" <<'PY'
import gzip, hashlib, io, json, pathlib, sys, tarfile

root, target, version, upstream, patch = sys.argv[1:]
root = pathlib.Path(root)
platform, arch = target.split("-")[:2]
binary = root / "build" / f"cli-{target}" / "bin" / "opencode"
with binary.open("rb") as handle:
    digest = hashlib.file_digest(handle, "sha256").hexdigest()
manifest = dict(version=version, upstream=upstream, platform=platform, arch=arch, sha256=digest,
                patch_sha256=hashlib.sha256(pathlib.Path(patch).read_bytes()).hexdigest())
archive = root / f"opencode-team-runtime-{version}-{target}.tar.gz"
with archive.open("xb") as raw, gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as zipped:
    with tarfile.open(fileobj=zipped, mode="w|", format=tarfile.USTAR_FORMAT) as tar:
        for name, file, mode in (("opencode", binary, 0o755), ("LICENSE", root / "source/LICENSE", 0o644),
                                 ("manifest.json", None, 0o644)):
            data = (json.dumps(manifest, sort_keys=True) + "\n").encode() if file is None else None
            entry = tarfile.TarInfo(name)
            entry.size = len(data) if data is not None else file.stat().st_size
            entry.mode = mode
            with (io.BytesIO(data) if data is not None else file.open("rb")) as handle:
                tar.addfile(entry, handle)
with archive.open("rb") as handle:
    asset = {"sha256": hashlib.file_digest(handle, "sha256").hexdigest(), "bytes": archive.stat().st_size}
(root / "runtime-lock.json").write_text(json.dumps({target: asset}, indent=2) + "\n")
print(archive)
PY
