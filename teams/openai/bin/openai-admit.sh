#!/bin/bash
set -euo pipefail
umask 077
normalize_identity() { printf '%s' "$1" | tr -d '\r' | awk '{$1=$1; print}' | tr ':' '_' | tr '[:upper:]' '[:lower:]'; }

state_root=${OPENAI_TEAM_STATE_ROOT:?OPENAI_TEAM_STATE_ROOT is required}
global_budget=${OPENAI_GLOBAL_BUDGET:-16}
[ "$global_budget" -gt 16 ] && global_budget=16
mkdir -p "$state_root/active" "$state_root/locks" "$state_root/logs" "$state_root/routes"
chmod 700 "$state_root" "$state_root/active" "$state_root/locks" "$state_root/logs" "$state_root/routes"
wait_for_slot=0
parent_session_id=""
call_id=""
owner_pid="${OPENAI_OWNER_PID:-${OPENAI_OPENCODE_PID:-}}"
reservation_owner_start="${OPENAI_OWNER_START_IDENTITY:-${OPENAI_OPENCODE_START_IDENTITY:-}}"
while [ $# -gt 0 ]; do
  case "$1" in
    --wait) wait_for_slot=1; shift ;;
    --parent) parent_session_id=${2:?parent session required}; shift 2 ;;
    --call) call_id=${2:?call id required}; shift 2 ;;
    --owner-pid) owner_pid=${2:?owner pid required}; shift 2 ;;
    --owner-start) reservation_owner_start=${2:?owner start required}; shift 2 ;;
    *) break ;;
  esac
done
if [ -z "$owner_pid" ]; then owner_pid="$PPID"; fi
if [ -z "$reservation_owner_start" ]; then reservation_owner_start=$(normalize_identity "$(ps -o lstart= -p "$owner_pid" 2>/dev/null || true)"); fi
reservation_owner_start=$(normalize_identity "$reservation_owner_start")
role=${1:?role required}
weight=${2:?weight required}
token=${3:-$(openssl rand -hex 8)}
[ -n "$token" ] && [[ "$token" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { echo "OPENAI_ADMISSION_TOKEN_INVALID" >&2; exit 2; }
[ "$weight" -gt 16 ] && { echo "weight exceeds hard maximum" >&2; exit 2; }
lock="$state_root/locks/budget.lock"
lock_owner="$$.$RANDOM.$RANDOM"
source "$(dirname "$0")/openai-budget-lock.sh"
openai_lock_init "$state_root" "$lock_owner"
acquire_lock() { openai_lock_acquire; }
release_lock() { openai_lock_release; }
trap release_lock EXIT HUP INT TERM

resource_pressure_ok() {
  local projected_global=$1
  [ "${OPENAI_SYNTHETIC_TEST:-0}" = 1 ] && return 0
  [ "$projected_global" -le 12 ] && return 0
  if ! command -v memory_pressure >/dev/null 2>&1; then
    return 1
  fi
  report=$(memory_pressure -Q 2>/dev/null || true)
  free_percent=$(printf '%s\n' "$report" | awk -F': ' '/System-wide memory free percentage:/ {gsub(/%/, "", $2); print $2; exit}')
  [ -n "$free_percent" ] && [ "$free_percent" -ge 20 ]
}

while true; do
  acquire_lock
  active_global=0
  active_parent=0
  for f in "$state_root"/active/*.json; do
    [ -f "$f" ] || continue
    stale=0
    record_pid=$(jq -r '.owner_pid // empty' "$f" 2>/dev/null || true)
    record_start=$(jq -r '.owner_start_identity // empty' "$f" 2>/dev/null || true)
    if [ -n "$record_pid" ]; then
      current_start=$(normalize_identity "$(ps -o lstart= -p "$record_pid" 2>/dev/null || true)")
      if ! kill -0 "$record_pid" 2>/dev/null; then
        stale=1
      elif [ -n "$current_start" ] && [ -n "$record_start" ] && [ "$current_start" != "$record_start" ]; then
        stale=1
      elif [ -z "$current_start" ] && [ "$record_pid" != "$PPID" ]; then
        created=$(jq -r '.created_at // 0' "$f" 2>/dev/null || printf 0)
        [ "$created" -gt 0 ] && [ $(( $(date +%s) - created )) -gt "${OPENAI_RESERVATION_STALE_AGE_SECONDS:-3600}" ] && stale=1
      fi
    else
      created=$(jq -r '.created_at // 0' "$f" 2>/dev/null || printf 0)
      [ "$created" -gt 0 ] && [ $(( $(date +%s) - created )) -gt "${OPENAI_RESERVATION_STALE_AGE_SECONDS:-3600}" ] && stale=1
    fi
    if [ "$stale" -eq 1 ]; then rm -f -- "$f"; continue; fi
    w=$(jq -r '.weight // 0' "$f")
    active_global=$((active_global + w))
    if [ -n "$parent_session_id" ] && [ "$(jq -r '.parent_session_id // ""' "$f")" = "$parent_session_id" ]; then
      active_parent=$((active_parent + w))
    fi
  done
  request_budget=12
  if [ -n "$parent_session_id" ] && [ -f "$state_root/routes/$parent_session_id.json" ]; then
    request_budget=$(jq -r '.request_budget // 12' "$state_root/routes/$parent_session_id.json")
  fi
  can_pressure=1
  projected_global=$((active_global + weight))
  resource_pressure_ok "$projected_global" || can_pressure=0
  if [ "$((active_global + weight))" -le "$global_budget" ] && \
     [ "$((active_global + weight))" -le 16 ] && \
     [ "$((active_parent + weight))" -le "$request_budget" ] && \
     [ "$can_pressure" -eq 1 ]; then
    tmp=$(mktemp "$state_root/active/.${token}.XXXXXX")
    jq -n --arg token "$token" --arg role "$role" --arg parent "$parent_session_id" --arg call "$call_id" --arg owner_start "$reservation_owner_start" --argjson owner_pid "$owner_pid" \
      --argjson weight "$weight" --argjson created_at "$(date +%s)" \
      '{token:$token,role:$role,weight:$weight,master_parent_session_id:$parent,parent_session_id:$parent,task_call_id:$call,call_id:$call,owner_pid:$owner_pid,owner_start_identity:$owner_start,created_at:$created_at}' > "$tmp"
    chmod 600 "$tmp"
    mv -f "$tmp" "$state_root/active/$token.json"
printf '%s\n' "event=admit timestamp=$(date +%s) role=$role classification=reservation global=$((active_global + weight))" >> "$state_root/logs/admission.log"
    chmod 600 "$state_root/logs/admission.log"
    release_lock
    printf '%s\n' "$token"
    exit 0
  fi
  printf '%s\n' "event=queue timestamp=$(date +%s) role=$role classification=reservation global=$active_global pressure=$can_pressure" >> "$state_root/logs/admission.log"
  chmod 600 "$state_root/logs/admission.log"
  release_lock
  [ "$wait_for_slot" -eq 1 ] || exit 75
  sleep 1
done
