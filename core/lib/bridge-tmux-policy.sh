#!/bin/bash

native_ui_only_agent() {
  local candidate="$1"
  local configured
  [ -n "${NATIVE_UI_ONLY_AGENTS:-}" ] || return 1
  IFS=',' read -ra configured_agents <<< "$NATIVE_UI_ONLY_AGENTS"
  for configured in "${configured_agents[@]}"; do
    configured=$(echo "$configured" | tr -d '[:space:]')
    [ "$candidate" = "$configured" ] && return 0
  done
  return 1
}

bridge_no_attach_action() {
  if native_ui_only_agent "$1"; then
    printf 'native-ui-only\n'
  else
    printf 'tmux-visible\n'
  fi
}

bridge_agent_label() {
  local agent="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  local title="$(printf '%s' "${2:-}" | tr '[:upper:]' '[:lower:]')"
  case "$agent" in
    explore) printf 'Explore\n'; return 0 ;;
    librarian) printf 'Librarian\n'; return 0 ;;
    openai-architect) printf 'Architect\n'; return 0 ;;
    openai-reviewer) printf 'Reviewer\n'; return 0 ;;
    openai-coder-1) printf 'Coder-1\n'; return 0 ;;
    openai-coder-2) printf 'Coder-2\n'; return 0 ;;
  esac
  case "$title" in
    *coder*1*) printf 'Coder-1\n' ;;
    *coder*2*) printf 'Coder-2\n' ;;
    *architect*) printf 'Architect\n' ;;
    *reviewer*) printf 'Reviewer\n' ;;
    *explore*|*search*|*codebase*) printf 'Explore\n' ;;
    *librarian*|*research*|*doc*) printf 'Librarian\n' ;;
    *) printf 'unknown\n' ;;
  esac
}
