#!/bin/bash
set -euo pipefail

root=${OPENAI_TEAM_STATE_ROOT:-/tmp}
directory="$root/work-packets"
if [ ! -d "$directory" ]; then
  printf '%s\n' "No local work packets have been recorded yet."
  exit 0
fi
shopt -s nullglob
packets=("$directory"/[a-f0-9][a-f0-9]*.json)
if [ "${#packets[@]}" -eq 0 ]; then
  printf '%s\n' "No local work packets have been recorded yet."
  exit 0
fi
for packet in "${packets[@]}"; do
  jq -r '[.packet_id, (.agent // ""), (.classification // ""), (.phase // ""), (.outcome // ""), (.updated_at // "")] | @tsv' "$packet" 2>/dev/null || true
done | sort -r -k6,6
