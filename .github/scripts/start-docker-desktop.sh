#!/usr/bin/env bash
set -euo pipefail

docker_error() {
  printf 'Docker Desktop / %s: %s\n' "$1" "$2" >&2
  exit 1
}

if ! command -v docker >/dev/null 2>&1; then
  brew install --cask docker || docker_error install 'Homebrew cask installation failed'
fi

if ! pgrep -x Docker >/dev/null 2>&1; then
  open -a Docker --args --accept-license --unattended || docker_error start 'Could not launch Docker Desktop'
fi

for attempt in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then
    docker info --format '{{.OSType}} {{.Architecture}}'
    exit 0
  fi
  sleep 5
done

docker_error readiness 'Docker Engine did not become ready within 5 minutes'
