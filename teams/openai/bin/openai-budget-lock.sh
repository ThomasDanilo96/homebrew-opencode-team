#!/bin/bash
# Shellcheck source=none
# A budget lock is published only after owner metadata exists.  Callers source
# this helper after setting state_root/root and lock_owner/owner.

openai_lock_init() {
  OPENAI_BUDGET_LOCK="$1/locks/budget.lock"
  OPENAI_BUDGET_OWNER="$2"
  OPENAI_BUDGET_HELD=0
  openai_lock_reclaim_mutex="$OPENAI_BUDGET_LOCK.reclaim"
  # A burst of releases is intentionally serialized.  Five seconds was short
  # enough for a 16/32 process burst to time out on a loaded host.
  OPENAI_BUDGET_WAIT=${OPENAI_LOCK_WAIT_SECONDS:-20}
  OPENAI_BUDGET_LEASE=${OPENAI_LOCK_LEASE_SECONDS:-30}
  OPENAI_BUDGET_GRACE=${OPENAI_LOCK_ORPHAN_GRACE_SECONDS:-1}
  for value in "$OPENAI_BUDGET_WAIT" "$OPENAI_BUDGET_LEASE" "$OPENAI_BUDGET_GRACE"; do
    case "$value" in ''|*[!0-9]*) echo "OPENAI_LOCK_INVALID_CONFIGURATION" >&2; return 2;; esac
  done
  [ "$OPENAI_BUDGET_LEASE" -gt 0 ] && [ "$OPENAI_BUDGET_LEASE" -le 300 ] || { echo "OPENAI_LOCK_INVALID_CONFIGURATION" >&2; return 2; }
}
openai_lock_owner_valid() {
  local pid token stamp lease start
  IFS=: read -r pid token stamp lease start < "$OPENAI_BUDGET_LOCK/owner" 2>/dev/null || return 1
  case "$pid:$token:$stamp:$lease:$start" in *[!0-9A-Za-z._:\ -]*|*::*|:::*) return 1;; esac
  case "$pid" in ''|*[!0-9]*) return 1;; esac
  case "$stamp" in ''|*[!0-9]*) return 1;; esac
  case "$lease" in ''|*[!0-9]*) return 1;; esac
  [ "$lease" -gt 0 ] && [ "$lease" -le 300 ]
}
openai_lock_process_start_identity() { LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null | awk '{$1=$1; print}' | tr -s ' ' | tr ':' '_'; }
openai_lock_mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || printf '0\n'; }
openai_lock_reclaim_enter() {
  local deadline=$((SECONDS + OPENAI_BUDGET_WAIT + 1)) stage token now age pid owner_start current_start lease_until
  while [ "$SECONDS" -lt "$deadline" ]; do
    stage="$openai_lock_reclaim_mutex.acquire.$$.$RANDOM"
    if mkdir "$stage" 2>/dev/null; then
      printf '%s:%s:%s:%s:%s\n' "$$" "$OPENAI_BUDGET_OWNER" "$(date +%s)" "$OPENAI_BUDGET_LEASE" "$(openai_lock_process_start_identity "$$")" > "$stage/owner"
      if perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$stage" "$openai_lock_reclaim_mutex" 2>/dev/null; then
        return 0
      fi
      rm -rf "$stage" 2>/dev/null || true
    fi
    IFS=: read -r pid token _ lease owner_start < "$openai_lock_reclaim_mutex/owner" 2>/dev/null || { pid=; token=; lease=; owner_start=; }
    stale_snapshot=$(cat "$openai_lock_reclaim_mutex/owner" 2>/dev/null || true)
    now=$(date +%s)
    current_start=$(openai_lock_process_start_identity "$pid" || true)
    if [ -n "$pid" ] && { ! kill -0 "$pid" 2>/dev/null || { [ -n "$current_start" ] && [ "$current_start" != "$owner_start" ]; } || { [ -z "$current_start" ] && [ "$now" -ge "$(( ${lease:-0} + OPENAI_BUDGET_GRACE ))" ]; }; }; then
      local fenced="$openai_lock_reclaim_mutex.stale.$RANDOM" successor="$openai_lock_reclaim_mutex.successor.$$.$RANDOM"
      if perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$openai_lock_reclaim_mutex" "$fenced" 2>/dev/null && mkdir "$successor" 2>/dev/null; then
        printf '%s:%s:%s:%s:%s\n' "$$" "$OPENAI_BUDGET_OWNER" "$(date +%s)" "$OPENAI_BUDGET_LEASE" "$(openai_lock_process_start_identity "$$")" > "$successor/owner"
        successor_owner=$(cat "$openai_lock_reclaim_mutex/owner" 2>/dev/null || true)
        if perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$successor" "$openai_lock_reclaim_mutex" 2>/dev/null && [ "$(cat "$fenced/owner" 2>/dev/null || true)" = "$stale_snapshot" ]; then
          case "$successor_owner" in "$$:$OPENAI_BUDGET_OWNER":*) rm -rf "$fenced"; openai_lock_reclaim_leave; continue;; esac
        fi
        rm -rf "$successor"; [ -e "$openai_lock_reclaim_mutex" ] || mv "$fenced" "$openai_lock_reclaim_mutex" 2>/dev/null || true
      fi
    elif [ -z "$pid" ]; then
      age=$((now - $(openai_lock_mtime "$openai_lock_reclaim_mutex")))
      if [ "$age" -ge "$OPENAI_BUDGET_GRACE" ]; then
        local fenced="$openai_lock_reclaim_mutex.stale.$RANDOM" successor="$openai_lock_reclaim_mutex.successor.$$.$RANDOM"
        if perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$openai_lock_reclaim_mutex" "$fenced" 2>/dev/null && mkdir "$successor" 2>/dev/null; then
          printf '%s:%s:%s:%s:%s\n' "$$" "$OPENAI_BUDGET_OWNER" "$(date +%s)" "$OPENAI_BUDGET_LEASE" "$(openai_lock_process_start_identity "$$")" > "$successor/owner"
          if perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$successor" "$openai_lock_reclaim_mutex" 2>/dev/null; then rm -rf "$fenced"; continue; fi
          rm -rf "$successor"; [ -e "$openai_lock_reclaim_mutex" ] || mv "$fenced" "$openai_lock_reclaim_mutex" 2>/dev/null || true
        fi
      fi
    fi
    sleep 0.02
  done
  rm -rf "$openai_lock_reclaim_mutex.acquire.$$.*" 2>/dev/null || true
  return 1
}
openai_lock_reclaim_leave() {
  local pid token fenced; pid=$(cut -d: -f1 "$openai_lock_reclaim_mutex/owner" 2>/dev/null || true); token=$(cut -d: -f2 "$openai_lock_reclaim_mutex/owner" 2>/dev/null || true)
  [ "$pid" = "$$" ] && [ "$token" = "$OPENAI_BUDGET_OWNER" ] || return 0
  fenced="$openai_lock_reclaim_mutex.release.$OPENAI_BUDGET_OWNER.$RANDOM"
  perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$openai_lock_reclaim_mutex" "$fenced" 2>/dev/null || return 0
  if [ "$(cut -d: -f2 "$fenced/owner" 2>/dev/null || true)" = "$OPENAI_BUDGET_OWNER" ]; then rm -rf "$fenced"; else perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$fenced" "$openai_lock_reclaim_mutex" 2>/dev/null || true; fi
}
openai_lock_quarantine() {
  local quarantine="$OPENAI_BUDGET_LOCK.quarantine.$OPENAI_BUDGET_OWNER.$RANDOM"
  local captured="${1:-}"
  local force="${2:-0}"
  [ -n "$captured" ] || captured=$(cat "$OPENAI_BUDGET_LOCK/owner" 2>/dev/null || true)
  [ -n "$captured" ] || captured='__empty_owner__'
  openai_lock_reclaim_enter || return 1
  local pid token stamp lease owner_start current_start lease_until now reclaim
  local canonical
  canonical=$(cat "$OPENAI_BUDGET_LOCK/owner" 2>/dev/null || true)
  [ "$canonical" = "$captured" ] || { openai_lock_reclaim_leave; return 0; }
  IFS=: read -r pid token stamp lease owner_start <<<"$captured"
  now=$(date +%s)
  current_start=$(openai_lock_process_start_identity "$pid" || true)
  lease_until=$((stamp + lease))
  reclaim=0
  if [ "$captured" = "__empty_owner__" ] || ! kill -0 "$pid" 2>/dev/null; then reclaim=1
  elif [ -n "$current_start" ] && [ "$current_start" != "$owner_start" ]; then reclaim=1
  elif [ -z "$current_start" ] && [ "$now" -ge "$((lease_until + OPENAI_BUDGET_GRACE))" ]; then reclaim=1
  fi
  canonical=$(cat "$OPENAI_BUDGET_LOCK/owner" 2>/dev/null || true)
  [ "$canonical" = "$captured" ] || { openai_lock_reclaim_leave; return 0; }
  current_start=$(openai_lock_process_start_identity "$pid" || true)
  reclaim=0
  if [ "$captured" = "__empty_owner__" ] || ! kill -0 "$pid" 2>/dev/null; then reclaim=1
  elif [ -n "$current_start" ] && [ "$current_start" != "$owner_start" ]; then reclaim=1
  elif [ -z "$current_start" ] && [ "$now" -ge "$((lease_until + OPENAI_BUDGET_GRACE))" ]; then reclaim=1
  fi
  [ "$force" = 1 ] || [ "$reclaim" = 1 ] || { openai_lock_reclaim_leave; return 0; }
  if [ -n "${OPENAI_LOCK_BEFORE_FENCE_HOOK:-}" ]; then
    "$OPENAI_LOCK_BEFORE_FENCE_HOOK" "$OPENAI_BUDGET_LOCK" "$captured" || true
  fi
  perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$OPENAI_BUDGET_LOCK" "$quarantine" 2>/dev/null || { openai_lock_reclaim_leave; return 1; }
  if [ "$(cat "$quarantine/owner" 2>/dev/null || true)" = "$captured" ]; then
    rm -rf "$quarantine"
  elif [ ! -e "$OPENAI_BUDGET_LOCK" ]; then
    perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$quarantine" "$OPENAI_BUDGET_LOCK" 2>/dev/null || true
  else
    local moved_pid
    moved_pid=${captured%%:*}
    :
  fi
  openai_lock_reclaim_leave
}
openai_lock_acquire() {
  local deadline stage pid now age
  if [ "$OPENAI_BUDGET_WAIT" -ge 5 ]; then deadline=$((SECONDS + OPENAI_BUDGET_WAIT + 120)); else deadline=$((SECONDS + OPENAI_BUDGET_WAIT + 2)); fi
  while :; do
    stage="$OPENAI_BUDGET_LOCK.staging.$OPENAI_BUDGET_OWNER.$RANDOM"
    # `mv` treats an extant directory as a parent on macOS.  Use rename(2)
    # directly so publication is a single canonical-path operation.
    if [ ! -e "$OPENAI_BUDGET_LOCK" ] && mkdir "$stage" 2>/dev/null; then
      printf '%s:%s:%s:%s:%s\n' "$$" "$OPENAI_BUDGET_OWNER" "$(date +%s)" "$OPENAI_BUDGET_LEASE" "$(openai_lock_process_start_identity "$$")" > "$stage/owner"
      if perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$stage" "$OPENAI_BUDGET_LOCK" 2>/dev/null; then
        case "$(cat "$OPENAI_BUDGET_LOCK/owner" 2>/dev/null || true)" in
          "$$:$OPENAI_BUDGET_OWNER":*:"$OPENAI_BUDGET_LEASE":*) OPENAI_BUDGET_HELD=1; return 0;;
        esac
      fi
      rm -rf "$stage"
    fi
    [ "$SECONDS" -lt "$deadline" ] || { echo "OPENAI_LOCK_TIMEOUT budget.lock" >&2; return 75; }
    if openai_lock_owner_valid; then
      # A concurrent releaser may remove a formerly valid owner between the
      # validation read and this one.  That is a retryable observation, not a
      # shell error under `set -e`.
       if ! IFS=: read -r pid _ stamp lease _ < "$OPENAI_BUDGET_LOCK/owner"; then
         continue
       fi
       owner_start=$(IFS=: read -r _ _ _ _ value < "$OPENAI_BUDGET_LOCK/owner" 2>/dev/null; printf '%s' "$value")
       current_start=$(openai_lock_process_start_identity "$pid" || true)
       lease_until=$((stamp + lease))
       reclaim=0
       if ! kill -0 "$pid" 2>/dev/null; then reclaim=1
       elif [ -n "$current_start" ] && [ "$current_start" != "$owner_start" ]; then reclaim=1
       elif [ -z "$current_start" ] && [ "$(date +%s)" -ge "$((lease_until + OPENAI_BUDGET_GRACE))" ]; then reclaim=1
       fi
        if [ "$reclaim" = 1 ]; then openai_lock_quarantine "$(cat "$OPENAI_BUDGET_LOCK/owner" 2>/dev/null || true)" || true; continue; fi
    else
      if openai_lock_quarantine "$(cat "$OPENAI_BUDGET_LOCK/owner" 2>/dev/null || true)"; then
        continue
      fi
    fi
    # Avoid a herd repeatedly colliding on the just-released directory.
      sleep "0.$((1 + RANDOM % 3))"
  done
}
openai_lock_release() {
  [ "$OPENAI_BUDGET_HELD" = 1 ] || return 0
  # Never report successful release while retaining a lock we still own.
  local captured_owner current_owner fenced moved_owner
  captured_owner=$(cat "$OPENAI_BUDGET_LOCK/owner" 2>/dev/null || true)
  case "$captured_owner" in
    "$$:$OPENAI_BUDGET_OWNER":*)
       if [ -n "${OPENAI_LOCK_BEFORE_FENCE_HOOK:-}" ]; then
         "$OPENAI_LOCK_BEFORE_FENCE_HOOK" "$OPENAI_BUDGET_LOCK" "$captured_owner" || true
       fi
       current_owner=$(cat "$OPENAI_BUDGET_LOCK/owner" 2>/dev/null || true)
       if [ "$current_owner" != "$captured_owner" ]; then
         OPENAI_BUDGET_HELD=0
         return 0
       fi
       fenced="$OPENAI_BUDGET_LOCK.release.$OPENAI_BUDGET_OWNER.$RANDOM"
       if ! perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$OPENAI_BUDGET_LOCK" "$fenced" 2>/dev/null; then
         if [ -e "$OPENAI_BUDGET_LOCK" ]; then
           echo "OPENAI_LOCK_RELEASE_FAILED budget.lock" >&2
           return 74
         fi
       elif [ -e "$fenced" ]; then
         moved_owner=$(cat "$fenced/owner" 2>/dev/null || true)
         if [ "$moved_owner" = "$captured_owner" ]; then
           rm -rf "$fenced"
         elif [ ! -e "$OPENAI_BUDGET_LOCK" ]; then
           perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$fenced" "$OPENAI_BUDGET_LOCK" 2>/dev/null || true
         fi
       fi
      ;;
  esac
  OPENAI_BUDGET_HELD=0
}
