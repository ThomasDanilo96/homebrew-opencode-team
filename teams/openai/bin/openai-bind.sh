#!/bin/bash
set -euo pipefail
umask 077
root=${OPENAI_TEAM_STATE_ROOT:?OPENAI_TEAM_STATE_ROOT is required}
token=${1:?reservation token required}
child=${2:?child session id required}
[ -n "$token" ] && [[ "$token" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { echo "OPENAI_BIND_TOKEN_INVALID" >&2; exit 2; }
file="$root/active/$token.json"
lock="$root/locks/budget.lock"
owner="$$.$RANDOM.$RANDOM"
tmp=""; locked=0
source "$(dirname "$0")/openai-budget-lock.sh"
openai_lock_init "$root" "$owner"
cleanup() { [ -n "$tmp" ] && rm -f "$tmp"; openai_lock_release; }
trap cleanup EXIT HUP INT TERM
mkdir -p "$root/active" "$root/locks"
chmod 700 "$root" "$root/active" "$root/locks"
openai_lock_acquire
[ -f "$file" ] || exit 1
existing=$(jq -r '.child_session_id // empty' "$file")
if [ -n "$existing" ]; then [ "$existing" = "$child" ] && exit 0; exit 73; fi
tmp=$(mktemp "$root/active/.${token}.${owner}.XXXXXX")
jq --arg child "$child" '.child_session_id=$child' "$file" > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$file"; tmp=""
