#!/bin/bash
# lib/config.sh — Strict KEY=VALUE parser for team-runtime.conf
# No shell expansion. No command substitution. No eval. Unknown keys = REFUSE.

# Forbidden characters anywhere in VALUE
_FORBIDDEN_CHARS='$~`(){};|&<>"'"'"''

# All allowed configuration variables (for explicit unset before parsing)
_ALL_CONFIG_VARS="TEAM_NAME SANDBOX RUNTIME_ROOT PERSISTENT_DATA_ROOT TMUX_PREFIX OMO_PROFILE OPENCODE_CONFIG PRE_SERVER_HOOK RUNTIME_ENV_HOOK XDG_CONFIG_HOME_OVERRIDE CLAUDE_CONFIG_DIR_OVERRIDE NATIVE_UI_ONLY_AGENTS RESUME_ALLOWED_AGENTS BRIDGE_MODE"

# Validate TEAM_NAME format
_validate_team_name() {
  local val="$1"
  case "$val" in
    ''|*[!A-Za-z0-9-]*)
      echo "ERROR: Invalid TEAM_NAME '$val' (must match ^[A-Za-z0-9-]+$)" >&2
      return 1
      ;;
  esac
}

# Validate TMUX_PREFIX format
_validate_tmux_prefix() {
  local val="$1"
  case "$val" in
    ''|*[!A-Za-z0-9._-]*)
      echo "ERROR: Invalid TMUX_PREFIX '$val' (must match ^[A-Za-z0-9._-]+$)" >&2
      return 1
      ;;
  esac
}

# Validate OMO_PROFILE format
_validate_omo_profile() {
  local val="$1"
  case "$val" in
    ''|*[!A-Za-z0-9._-]*)
      echo "ERROR: Invalid OMO_PROFILE '$val' (must match ^[A-Za-z0-9._-]+$)" >&2
      return 1
      ;;
  esac
}

# Validate the generic bridge strategy.
_validate_bridge_mode() {
  case "$1" in
    tmux|native_ui) ;;
    *)
      echo "ERROR: Invalid BRIDGE_MODE '$1' (must be tmux or native_ui)" >&2
      return 1
      ;;
  esac
}

# Validate comma-separated agent labels without allowing shell syntax.
_validate_native_ui_agents() {
  local val="$1"
  local agent
  [ -z "$val" ] && return 0
  local -a agents=()
  IFS=',' read -ra agents <<< "$val"
  for agent in "${agents[@]}"; do
    agent=$(echo "$agent" | tr -d '[:space:]')
    [ -z "$agent" ] && continue
    case "$agent" in
      ''|*[!A-Za-z0-9_-]*)
        echo "ERROR: Invalid agent name '$agent' in NATIVE_UI_ONLY_AGENTS" >&2
        return 1
        ;;
    esac
  done
}

# Validate the required root-session agent allowlist. Labels deliberately use
# the same conservative alphabet as runtime agent identifiers, including '-'
# for labels such as OpenCode-Builder. Whitespace and empty list elements are
# refused so this value cannot be interpreted as shell syntax.
_validate_resume_allowed_agents() {
  local val="$1"
  local agent
  case "$val" in
    ''|,*|*,|*,,*)
      echo "ERROR: RESUME_ALLOWED_AGENTS must be a non-empty comma-separated agent list" >&2
      return 1
      ;;
  esac
  local -a agents=()
  IFS=',' read -ra agents <<< "$val"
  for agent in "${agents[@]}"; do
    case "$agent" in
      ''|*[!A-Za-z0-9_-]*)
        echo "ERROR: Invalid agent name '$agent' in RESUME_ALLOWED_AGENTS" >&2
        return 1
        ;;
    esac
  done
}

# Check for forbidden characters anywhere in value
_check_forbidden_chars() {
  local key="$1" value="$2" line_num="$3"
  local i
  for i in $(seq 1 ${#_FORBIDDEN_CHARS}); do
    local ch="${_FORBIDDEN_CHARS:$((i-1)):1}"
    case "$value" in
      *"$ch"*)
        echo "ERROR: Forbidden character '$ch' in $key value at line $line_num" >&2
        return 1
        ;;
    esac
  done
  return 0
}

# Realpath containment check using Python
_check_path_containment() {
  local hook="$1" sandbox="$2"
  python3 -c "
import os, sys
hook = os.path.realpath('$hook')
sandbox = os.path.realpath('$sandbox')
if not (hook == sandbox or hook.startswith(sandbox + '/')):
    sys.exit(1)
" 2>/dev/null
}

# Canonicalize path using Python realpath
_realpath() {
  python3 -c "import os; print(os.path.realpath('$1'))" 2>/dev/null
}

parse_team_config() {
  local config_file="$1"

  if [ -z "$config_file" ]; then
    echo "ERROR: --config argument required" >&2
    return 1
  fi

  if [ ! -f "$config_file" ]; then
    echo "ERROR: Config file not found: $config_file" >&2
    return 1
  fi

  # Explicitly unset ALL config variables before parsing
  # This prevents inherited environment from satisfying missing keys
  for var in $_ALL_CONFIG_VARS; do
    unset "$var"
  done

  local allowed_keys="TEAM_NAME SANDBOX RUNTIME_ROOT PERSISTENT_DATA_ROOT TMUX_PREFIX OMO_PROFILE OPENCODE_CONFIG PRE_SERVER_HOOK RUNTIME_ENV_HOOK XDG_CONFIG_HOME_OVERRIDE CLAUDE_CONFIG_DIR_OVERRIDE NATIVE_UI_ONLY_AGENTS RESUME_ALLOWED_AGENTS BRIDGE_MODE"
  local line_num=0
  local seen_keys=""

  while IFS= read -r line || [ -n "$line" ]; do
    line_num=$((line_num + 1))

    # Skip comments and blank lines
    case "$line" in
      \#*|"") continue ;;
    esac

    # Must match KEY=VALUE pattern. The native-agent list may be explicitly empty.
    case "$line" in
      NATIVE_UI_ONLY_AGENTS=) ;;
      *)
        if ! echo "$line" | grep -qE '^[A-Z][A-Z0-9_]*=.+$'; then
          echo "ERROR: Invalid syntax at line $line_num: $line" >&2
          return 1
        fi
        ;;
    esac

    local key="${line%%=*}"
    local value="${line#*=}"

    # NATIVE_UI_ONLY_AGENTS may intentionally be empty.
    if [ -z "$value" ] && [ "$key" != "NATIVE_UI_ONLY_AGENTS" ]; then
      echo "ERROR: Empty value for $key at line $line_num" >&2
      return 1
    fi

    # Unknown key check
    local found=0
    for ak in $allowed_keys; do
      if [ "$key" = "$ak" ]; then
        found=1
        break
      fi
    done
    if [ "$found" -eq 0 ]; then
      echo "ERROR: Unknown key '$key' at line $line_num" >&2
      return 1
    fi

    # Duplicate key check
    case " $seen_keys " in
      *" $key "*)
        echo "ERROR: Duplicate key '$key' at line $line_num" >&2
        return 1
        ;;
    esac
    seen_keys="$seen_keys $key"

    # Forbidden characters check (ANYWHERE in value)
    _check_forbidden_chars "$key" "$value" "$line_num" || return 1

    # Absolute path check for path keys
    case "$key" in
      SANDBOX|RUNTIME_ROOT|PERSISTENT_DATA_ROOT|OPENCODE_CONFIG|PRE_SERVER_HOOK|RUNTIME_ENV_HOOK|XDG_CONFIG_HOME_OVERRIDE|CLAUDE_CONFIG_DIR_OVERRIDE)
        case "$value" in
          /*) ;;
          *)
            echo "ERROR: $key must be absolute path at line $line_num" >&2
            return 1
            ;;
        esac
        ;;
    esac

    # Format validation for specific keys
    case "$key" in
      TEAM_NAME) _validate_team_name "$value" || return 1 ;;
      TMUX_PREFIX) _validate_tmux_prefix "$value" || return 1 ;;
      OMO_PROFILE) _validate_omo_profile "$value" || return 1 ;;
      NATIVE_UI_ONLY_AGENTS) _validate_native_ui_agents "$value" || return 1 ;;
      RESUME_ALLOWED_AGENTS) _validate_resume_allowed_agents "$value" || return 1 ;;
      BRIDGE_MODE) _validate_bridge_mode "$value" || return 1 ;;
    esac

    # Export the key=value (safe: key is validated, value has no shell chars)
    export "$key=$value"

  done < "$config_file"

  # Validate required keys (using indirect expansion, NO eval)
  for required in TEAM_NAME SANDBOX RUNTIME_ROOT PERSISTENT_DATA_ROOT TMUX_PREFIX OMO_PROFILE OPENCODE_CONFIG RESUME_ALLOWED_AGENTS BRIDGE_MODE; do
    local val="${!required:-}"
    if [ -z "$val" ]; then
      echo "ERROR: Required key $required missing" >&2
      return 1
    fi
  done

  # Validate SANDBOX exists and is directory
  if [ ! -d "$SANDBOX" ]; then
    echo "ERROR: SANDBOX does not exist or is not a directory: $SANDBOX" >&2
    return 1
  fi

  for runtime_path in "$RUNTIME_ROOT" "$PERSISTENT_DATA_ROOT"; do
    if [ ! -d "$runtime_path" ]; then
      echo "ERROR: configured runtime path does not exist or is not a directory: $runtime_path" >&2
      return 1
    fi
  done

  # Validate OPENCODE_CONFIG exists and is regular file
  if [ ! -f "$OPENCODE_CONFIG" ]; then
    echo "ERROR: OPENCODE_CONFIG does not exist or is not a file: $OPENCODE_CONFIG" >&2
    return 1
  fi

  # Validate PRE_SERVER_HOOK if provided
  if [ -n "${PRE_SERVER_HOOK:-}" ]; then
    if [ ! -f "$PRE_SERVER_HOOK" ]; then
      echo "ERROR: PRE_SERVER_HOOK does not exist: $PRE_SERVER_HOOK" >&2
      return 1
    fi
    if [ ! -x "$PRE_SERVER_HOOK" ]; then
      echo "ERROR: PRE_SERVER_HOOK is not executable: $PRE_SERVER_HOOK" >&2
      return 1
    fi
    # Canonicalize and check containment
    local real_hook real_sandbox
    real_hook=$(_realpath "$PRE_SERVER_HOOK")
    real_sandbox=$(_realpath "$SANDBOX")
    if [ -z "$real_hook" ] || [ -z "$real_sandbox" ]; then
      echo "ERROR: Failed to canonicalize paths" >&2
      return 1
    fi
    if ! _check_path_containment "$PRE_SERVER_HOOK" "$SANDBOX"; then
      echo "ERROR: PRE_SERVER_HOOK must be inside SANDBOX: $PRE_SERVER_HOOK" >&2
      return 1
    fi
  fi

  if [ -n "${RUNTIME_ENV_HOOK:-}" ] && [ ! -f "$RUNTIME_ENV_HOOK" ]; then
    echo "ERROR: RUNTIME_ENV_HOOK does not exist: $RUNTIME_ENV_HOOK" >&2
    return 1
  fi

  # Validate XDG_CONFIG_HOME_OVERRIDE if provided
  if [ -n "${XDG_CONFIG_HOME_OVERRIDE:-}" ]; then
    if [ ! -d "$XDG_CONFIG_HOME_OVERRIDE" ]; then
      echo "ERROR: XDG_CONFIG_HOME_OVERRIDE does not exist or is not a directory: $XDG_CONFIG_HOME_OVERRIDE" >&2
      return 1
    fi
  fi

  if [ -n "${CLAUDE_CONFIG_DIR_OVERRIDE:-}" ]; then
    if [ ! -d "$CLAUDE_CONFIG_DIR_OVERRIDE" ]; then
      echo "ERROR: CLAUDE_CONFIG_DIR_OVERRIDE does not exist or is not a directory: $CLAUDE_CONFIG_DIR_OVERRIDE" >&2
      return 1
    fi
    if [ ! -f "$CLAUDE_CONFIG_DIR_OVERRIDE/settings.json" ]; then
      echo "ERROR: CLAUDE_CONFIG_DIR_OVERRIDE must contain settings.json: $CLAUDE_CONFIG_DIR_OVERRIDE" >&2
      return 1
    fi
  fi

  return 0
}
