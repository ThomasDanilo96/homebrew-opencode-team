#!/bin/zsh
# Safe-cache functions ported from the original disk-cleanup.sh --safe-caches-only.
# No legacy broad cleanup, package updates, downloads, or persistent profile data.
set -euo pipefail

DRY_RUN=0
for argument in "$@"; do
  case "$argument" in
    --dry-run) DRY_RUN=1 ;;
    --safe-caches-only) ;;
    *) print -u2 "Unknown option: $argument"; exit 2 ;;
  esac
done

browser_caches() {
  /usr/bin/python3 - "$DRY_RUN" <<'PY'
import shutil
import subprocess
import sys
from pathlib import Path

home = Path.home()
dry_run = sys.argv[1] == '1'


def safe_path(path):
    return (path.is_absolute() and '..' not in path.parts
            and path.is_relative_to(home)
            and not any(p.is_symlink() for p in (path, *path.parents)))


def command(args):
    return subprocess.run(args, text=True, capture_output=True, timeout=30, check=True)


def runtime():
    processes = command(['ps', '-axo', 'comm=']).stdout.lower()
    files = command(['lsof', '-nP', '-Fn'])
    if files.stderr or not files.stdout.strip():
        raise ValueError('uncertain open-file check')
    return processes, files.stdout


def size(path):
    return int(command(['du', '-sk', str(path)]).stdout.split()[0]) * 1024


try:
    processes, files = runtime()
except (OSError, ValueError, subprocess.SubprocessError) as error:
    print(f'SKIP browser caches runtime check failed: {type(error).__name__}')
    sys.exit(0)

failed = False
for name in ('Chrome', 'Chrome-headless'):
    path = home / 'Library/Caches/Google' / name
    if not safe_path(path):
        print(f'SKIP Google {name}: symlink or unsafe path')
        continue
    if not path.exists():
        print(f'SKIP Google {name}: not found')
        continue
    if 'chrome' in processes or 'chromium' in processes or str(path) in files:
        print(f'SKIP Google {name}: browser active')
        continue
    try:
        before = size(path)
        if dry_run:
            print(f'DRY-RUN Google {name} candidate_bytes={before} reclaimed_bytes=0')
            continue
        # Recheck immediately before removal; never stop a browser to clean it.
        processes_now, files_now = runtime()
        if 'chrome' in processes_now or 'chromium' in processes_now or str(path) in files_now:
            print(f'SKIP Google {name}: browser active')
            continue
        if not safe_path(path):
            raise ValueError('path changed')
        shutil.rmtree(path)
        print(f'OK Google {name} reclaimed_bytes={before}')
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f'ERR Google {name}: {type(error).__name__}')
        failed = True

# Playwright exposes no offline-only GC. Preserve every revision and do not
# execute registered package code merely to report that cleanup is skipped.
print('SKIP Playwright native GC: download-capable install disabled; reclaimed_bytes=0')
sys.exit(int(failed))
PY
}

docker_cache() {
  /usr/bin/python3 - "$DRY_RUN" <<'PY'
import os
import shutil
import subprocess
import sys
from pathlib import Path

dry_run = sys.argv[1] == '1'
home = Path.home()
socket_path = home / '.docker/run/docker.sock'
docker = shutil.which('docker')


def safe_path(path):
    return (path.is_absolute() and '..' not in path.parts
            and path.is_relative_to(home)
            and not any(p.is_symlink() for p in (path, *path.parents)))


def run(args, timeout=90):
    return subprocess.run(args, text=True, capture_output=True, timeout=timeout, check=False,
                          env=base_env)


if not docker:
    print('SKIP Docker build cache: docker CLI unavailable')
    sys.exit(0)
if not safe_path(socket_path) or not socket_path.is_socket():
    print('SKIP Docker build cache: local Docker Desktop socket unavailable or symlinked')
    sys.exit(0)

base_env = {key: value for key, value in os.environ.items()
            if not key.startswith(('DOCKER_', 'BUILDX_'))}
base_env['DOCKER_HOST'] = f'unix://{socket_path}'
base_env['DOCKER_CONTEXT'] = 'desktop-linux'
base_env['DOCKER_CONFIG'] = str(home / '.docker')
base_env['BUILDX_CONFIG'] = str(home / '.docker/buildx')

try:
    context = run([docker, 'context', 'inspect', 'desktop-linux',
                   '--format', '{{json .Endpoints.docker.Host}}'])
except (OSError, subprocess.SubprocessError):
    print('SKIP Docker build cache: local context inspection unavailable')
    sys.exit(0)
if context.returncode != 0:
    print('SKIP Docker build cache: local context unavailable')
    sys.exit(0)
context_endpoint = context.stdout.strip().strip('"')
if context_endpoint != f'unix://{socket_path}':
    print('ERR Docker build cache: desktop-linux context is not the exact local home socket')
    sys.exit(1)

try:
    inspect = run([docker, 'buildx', 'inspect', 'desktop-linux'])
except (OSError, subprocess.SubprocessError):
    print('SKIP Docker build cache: local builder inspection unavailable')
    sys.exit(0)
if inspect.returncode != 0:
    print('SKIP Docker build cache: local builder unavailable')
    sys.exit(0)

lines = [line.strip() for line in inspect.stdout.splitlines() if line.strip()]
node_lines = []
for line in lines:
    if line == 'Devices:':
        break
    node_lines.append(line)
driver = next((line.split(':', 1)[1].strip() for line in node_lines
               if line.startswith('Driver:')), None)
node_names = [line.split(':', 1)[1].strip() for line in node_lines if line.startswith('Name:')]
node_endpoints = [line.split(':', 1)[1].strip() for line in node_lines if line.startswith('Endpoint:')]
if (driver != 'docker' or node_names != ['desktop-linux', 'desktop-linux']
        or node_endpoints != ['desktop-linux']):
    print('ERR Docker build cache: target is not the local desktop-linux docker driver')
    sys.exit(1)

try:
    usage = run([docker, 'system', 'df'])
except (OSError, subprocess.SubprocessError):
    print('SKIP Docker build cache: cache inspection unavailable')
    sys.exit(0)
if usage.returncode != 0:
    print('SKIP Docker build cache: cache inspection unavailable')
    sys.exit(0)

if dry_run:
    print('DRY-RUN Docker build cache candidate: docker system df')
    print('DRY-RUN candidate command: docker --context=desktop-linux buildx --builder desktop-linux prune --force --filter until=168h')
    sys.exit(0)

if not safe_path(socket_path) or not socket_path.is_socket():
    print('ERR Docker build cache: socket changed')
    sys.exit(1)
try:
    prune = run([docker, '--context=desktop-linux', 'buildx', '--builder', 'desktop-linux',
                 'prune', '--force', '--filter', 'until=168h'])
except (OSError, subprocess.SubprocessError) as error:
    print(f'ERR Docker build cache: {type(error).__name__}')
    sys.exit(1)
if prune.returncode != 0:
    detail = prune.stderr.strip() or prune.stdout.strip() or 'no diagnostic output'
    print(f'ERR Docker build cache: prune failed: {detail}')
    sys.exit(1)
print(prune.stdout.strip())
print('OK Docker build cache')
sys.exit(0)
PY
}

serena_logs() {
  /usr/bin/python3 - "$DRY_RUN" <<'PY'
import re
import subprocess
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

dry_run = sys.argv[1] == '1'
home = Path.home()
logs = home / '.serena/logs'
retention_days = 30
now = time.time()
DATE_DIR = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def safe_path(path):
    return (path.is_absolute() and '..' not in path.parts
            and path.is_relative_to(home)
            and not any(p.is_symlink() for p in (path, *path.parents)))


def open_files():
    result = subprocess.run(['lsof', '-nP', '-Fn'], text=True, capture_output=True,
                            timeout=60, check=True)
    if result.stderr or not result.stdout.strip():
        raise ValueError('uncertain open-file check')
    return {line[1:] for line in result.stdout.splitlines() if line.startswith('n')}


if not safe_path(logs) or not logs.is_dir():
    print('SKIP Serena logs: log directory absent or symlinked')
    sys.exit(0)
try:
    held = open_files()
except (OSError, ValueError, subprocess.SubprocessError) as error:
    print(f'SKIP Serena logs runtime check failed: {type(error).__name__}')
    sys.exit(0)

cutoff = now - retention_days * 86400
oldest_date = datetime.now(tz=timezone.utc).date() - timedelta(days=retention_days)
candidate = 0
reclaimed = 0
removed = 0
failed = False
emptied = []
for directory in sorted(logs.iterdir()):
    if not DATE_DIR.match(directory.name) or not directory.is_dir() or directory.is_symlink():
        continue
    try:
        directory_date = date.fromisoformat(directory.name)
    except ValueError:
        continue
    if directory_date > oldest_date:
        continue
    directory_removed = 0
    for entry in sorted(directory.iterdir()):
        # Only regular *.log files; never databases, auth, nested trees or links.
        if entry.suffix != '.log' or entry.is_symlink() or not entry.is_file():
            continue
        try:
            stat = entry.stat()
            if stat.st_mtime >= cutoff or str(entry) in held:
                continue
            if dry_run:
                print(f'DRY-RUN Serena log {entry} bytes={stat.st_size}')
                candidate += stat.st_size
                continue
            # Fail closed if a log was opened, replaced or touched since preflight.
            if str(entry) in open_files() or not safe_path(entry) or entry.stat() != stat:
                continue
            entry.unlink()
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            print(f'ERR Serena log {entry}: {type(error).__name__}')
            failed = True
            continue
        reclaimed += stat.st_size
        removed += 1
        directory_removed += 1
    if directory_removed:
        emptied.append(directory)

if not dry_run:
    for directory in emptied:
        try:
            directory.rmdir()
        except OSError:
            # A dated directory with remaining entries is deliberately preserved.
            if not directory.is_dir() or not any(directory.iterdir()):
                raise
if dry_run:
    print(f'DRY-RUN Serena logs candidate_bytes={candidate} reclaimed_bytes=0')
else:
    print(f'OK Serena logs removed_files={removed} reclaimed_bytes={reclaimed}')
sys.exit(int(failed))
PY
}

failed=0
browser_caches || failed=1
docker_cache || failed=1
serena_logs || failed=1
exit "$failed"
