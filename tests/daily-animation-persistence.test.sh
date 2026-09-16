#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export SANDBOX="$tmp/sandbox"
export XDG_STATE_HOME="$tmp/state"
mkdir -p "$SANDBOX/../dependencies/openai"

start_daily() { ( source "$ROOT/teams/daily/runtime-env.sh" ); }
kv="$XDG_STATE_HOME/opencode/kv.json"

start_daily
node --input-type=module -e 'import { readFile } from "node:fs/promises"; const value=JSON.parse(await readFile(process.argv[1])); if (value.animations_enabled !== false || Object.keys(value).length !== 1) throw new Error("absent file case failed")' "$kv"

node --input-type=module -e 'import { writeFile } from "node:fs/promises"; await writeFile(process.argv[1], JSON.stringify({unrelated: "keep", animations_enabled: true}));' "$kv"
start_daily
node --input-type=module -e 'import { readFile } from "node:fs/promises"; const value=JSON.parse(await readFile(process.argv[1])); if (value.unrelated !== "keep" || value.animations_enabled !== false) throw new Error("merge case failed")' "$kv"
before="$(shasum -a 256 "$kv")"; inode_before="$(stat -f %i "$kv")"; start_daily; after="$(shasum -a 256 "$kv")"; inode_after="$(stat -f %i "$kv")"
[ "$before" = "$after" ] && [ "$inode_before" = "$inode_after" ]

printf '%s' '{"preserve":"this"' > "$kv"; before="$(shasum -a 256 "$kv")"
if start_daily 2>/dev/null; then exit 1; fi
[ "$before" = "$(shasum -a 256 "$kv")" ]
printf '%s\n' 'daily animation persistence: ok'
