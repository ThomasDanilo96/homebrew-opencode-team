#!/usr/bin/env bash
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  brew install --cask docker
fi

if ! pgrep -x Docker >/dev/null 2>&1; then
  open -a Docker --args --accept-license --unattended
fi

for attempt in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then
    docker info --format '{{.OSType}} {{.Architecture}}'
    exit 0
  fi
  sleep 5
done

printf '%s\n' 'Docker Desktop did not become ready within 5 minutes' >&2
exit 1
