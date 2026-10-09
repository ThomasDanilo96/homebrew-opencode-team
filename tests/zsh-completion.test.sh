#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPLETION_DIR="$ROOT/completions"
COMPLETION_FILE="$COMPLETION_DIR/_opencode-team"

command -v zsh >/dev/null 2>&1 || { printf '%s\n' 'zsh is required for completion tests' >&2; exit 1; }
zsh -n "$COMPLETION_FILE"

registered="$(zsh -f -c 'fpath=("$1" $fpath); autoload -Uz compinit; compinit -i -D; print -r -- "${_comps[opencode-team]:-missing}"; print -r -- "${_comps[opencode-daily-team]:-missing}"' zsh "$COMPLETION_DIR")"
expected=$'_opencode-team\n_opencode-team'
test "$registered" = "$expected"

root_candidates="$(zsh -f -c '
  source "$1/_opencode-team"
  _arguments() { if [[ "$*" == *"->profile"* ]]; then state=profile; elif (( CURRENT == 2 )); then state=command; else state=argument; fi; }
  _describe() { local -a items; eval "items=(\"\${${2}[@]}\")"; print -rl -- "${items[@]}"; }
  words=(opencode-team b); CURRENT=2; _opencode-team
' zsh "$COMPLETION_DIR")"
[[ "$root_candidates" == *'best:Start the BEST profile'* ]]
[[ "$root_candidates" == *'free:Start the FREE OpenCode Zen profile'* ]]

profile_candidates="$(zsh -f -c '
  source "$1/_opencode-team"
  _arguments() { if [[ "$*" == *"->profile"* ]]; then state=profile; elif (( CURRENT == 2 )); then state=command; else state=argument; fi; }
  _describe() { local -a items; eval "items=(\"\${${2}[@]}\")"; print -rl -- "${items[@]}"; }
  words=(opencode-team start b); CURRENT=3; _opencode-team
' zsh "$COMPLETION_DIR")"
[[ "$profile_candidates" == *'best:General OpenCode Team profile'* ]]
[[ "$profile_candidates" == *'free:BEST routing with OpenCode Zen free models'* ]]

maintenance_candidates="$(zsh -f -c '
  source "$1/_opencode-team"
  _describe() { local -a items; eval "items=(\"\${${2}[@]}\")"; print -rl -- "${items[@]}"; }
  _arguments() { if (( CURRENT == 2 )); then state=command; else state=argument; fi; }
  words=(opencode-team maintenance version-check); CURRENT=3; _opencode-team
' zsh "$COMPLETION_DIR")"
[[ "$maintenance_candidates" == *'version-check:Check for a new OpenCode Team release'* ]]

printf '%s\n' 'ZSH COMPLETION PASS'
