#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

check_profile() {
  local team="$1" expected="$2"
  output="$(bash -c 'source "$1/core/lib/core.sh"; TEAM_NAME="$2"; PARENT_SESSION_ID=ses_resume_test; print_resume_command' bash "$ROOT" "$team")"
  expected_output=$'\nResume this session:\nopencode-team '
  expected_output+="$expected --resume ses_resume_test"
  [ "$output" = "$expected_output" ]
}

check_profile best best
check_profile go go
check_profile openai openai
check_profile opencode-openai-daily daily

empty_output="$(bash -c 'source "$1/core/lib/core.sh"; TEAM_NAME=daily; PARENT_SESSION_ID=; print_resume_command' bash "$ROOT")"
[ -z "$empty_output" ]

if TEAM_RUNTIME_INNER=1 RUN_ID=12345678 bash "$ROOT/core/bin/team-runtime" --config /does/not/exist --resume invalid >/dev/null 2>&1; then
  printf '%s\n' 'invalid resume ID was accepted' >&2
  exit 1
fi

printf '%s\n' 'core resume command: ok'
