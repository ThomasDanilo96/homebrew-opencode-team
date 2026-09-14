#!/bin/bash
set -euo pipefail
umask 077

root=${OPENAI_TEAM_STATE_ROOT:?OPENAI_TEAM_STATE_ROOT is required}
token=${1:?reservation token required}
[ -n "$token" ] && [[ "$token" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { echo "OPENAI_RELEASE_TOKEN_INVALID" >&2; exit 2; }
lock="$root/locks/budget.lock"
owner="$$.$RANDOM.$RANDOM"; locked=0
source "$(dirname "$0")/openai-budget-lock.sh"
openai_lock_init "$root" "$owner"
cleanup() { openai_lock_release; }
trap cleanup EXIT HUP INT TERM
mkdir -p "$root/locks" "$root/logs"
chmod 700 "$root" "$root/locks" "$root/logs" "$root/active" 2>/dev/null || true
file="$root/active/$token.json"
if ! openai_lock_acquire; then
  [ ! -e "$file" ] && exit 0
  exit 75
fi
if [ -e "$file" ] && [ ! -f "$file" ]; then
  echo "OPENAI_RELEASE_TOKEN_INVALID" >&2
  exit 2
fi
if [ -f "$file" ]; then
  [ "$(jq -r '.token // empty' "$file" 2>/dev/null || true)" = "$token" ] || { echo "OPENAI_RELEASE_TOKEN_MISMATCH" >&2; exit 73; }
  metadata=$(jq -r '[.role // "unknown", .weight // 0] | @tsv' "$file" 2>/dev/null || printf 'unknown\t0')
  if ! rm -f "$file" || [ -e "$file" ]; then
    echo "OPENAI_RELEASE_REMOVE_FAILED token=$token" >&2
    exit 74
  fi
  printf '%s\n' "event=release timestamp=$(date +%s) role=$(printf '%s' "$metadata" | cut -f1) classification=reservation" >> "$root/logs/admission.log"
  chmod 600 "$root/logs/admission.log"
fi
cleanup
