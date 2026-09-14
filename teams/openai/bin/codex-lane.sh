#!/bin/bash
set -euo pipefail
umask 077

root=${OPENAI_TEAM_STATE_ROOT:?OPENAI_TEAM_STATE_ROOT is required}
repo=${OPENAI_REPOSITORY_PATH:-$PWD}
task=${1:?task required}
model=${OPENAI_CODEX_MODEL:?OPENAI_CODEX_MODEL is required}
profile=${OPENAI_CODEX_PROFILE:-standard}
requested_model=${OPENAI_CODEX_REQUESTED_MODEL:-$model}
if [ -n "${OPENAI_CODEX_INVOCATION_ID:-}" ]; then
  invocation_id=$OPENAI_CODEX_INVOCATION_ID
else
  invocation_id=$(python3 -c 'import uuid; print(uuid.uuid4())')
fi
fallback_model=${OPENAI_CODEX_FALLBACK_MODEL:-}
fallback_reason_from_parent=${OPENAI_CODEX_FALLBACK_REASON:-}
fallback_reason=$fallback_reason_from_parent
fallback_count=${OPENAI_CODEX_FALLBACK_COUNT:-0}
fallback_eligible=0
provider_failure=0
case "$fallback_count" in 0|1) ;; *) printf '%s\n' 'OPENAI_CODEX_FALLBACK_COUNT must be 0 or 1' >&2; exit 2 ;; esac
if ! [[ "$invocation_id" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-4[0-9A-Fa-f]{3}-[89AaBb][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$ ]]; then
  printf '%s\n' 'OPENAI_CODEX_INVOCATION_ID must be a UUIDv4' >&2
  exit 2
fi
reasoning_effort=${OPENAI_CODEX_REASONING_EFFORT:-low}
compact_token_limit=${OPENAI_CODEX_COMPACT_TOKEN_LIMIT:-60000}
compact_prompt="Preserve objective and acceptance criteria decisions and constraints modified files and symbols tests and results exact unresolved errors and next action discard raw tool output repeated logs and superseded hypotheses"
token_threshold=${OPENAI_TOKEN_WARN_CODEX_UNCACHED:-30000}
case "$reasoning_effort" in
  minimal|low|medium|high|xhigh) ;;
  *)
    printf '%s\n' "OPENAI_CODEX_REASONING_EFFORT must be one of: minimal, low, medium, high, xhigh" >&2
    exit 2
    ;;
esac
case "$compact_token_limit" in ''|*[!0-9]*|0|0[0-9]*) printf '%s\n' "OPENAI_CODEX_COMPACT_TOKEN_LIMIT must be a positive integer" >&2; exit 2 ;; esac
case "$token_threshold" in ''|*[!0-9]*) printf '%s\n' "OPENAI_TOKEN_WARN_CODEX_UNCACHED must be a non-negative integer" >&2; exit 2 ;; esac
mkdir -p "$root/codex" "$root/handoffs" "$root/logs" "$root/locks"
chmod 0700 "$root/codex" "$root/handoffs" "$root/logs" "$root/locks"
artifact_ttl=${OPENAI_CODEX_ARTIFACT_TTL_SECONDS:-86400}
case "$artifact_ttl" in ''|*[!0-9]*) artifact_ttl=86400;; esac
[ "$artifact_ttl" -lt 60 ] && artifact_ttl=60
[ "$artifact_ttl" -gt 2592000 ] && artifact_ttl=2592000
prune_artifacts() {
  return 0
}
prune_artifacts "$root/codex"
prune_artifacts "$root/handoffs"
fingerprint=${OPENAI_CODEX_TASK_FINGERPRINT:-}
resume_thread_id=${OPENAI_CODEX_RESUME_THREAD_ID:-}
parent_codex_run_id=${OPENAI_CODEX_PARENT_RUN_ID:-}
resume_count=${OPENAI_CODEX_RESUME_COUNT:-0}
attempt=${OPENAI_CODEX_ATTEMPT:-1}
if [ -n "$fingerprint" ] && ! [[ "$fingerprint" =~ ^[A-Fa-f0-9]{64,128}$ ]]; then printf '%s\n' "OPENAI_CODEX_TASK_FINGERPRINT must be a hash" >&2; exit 2; fi
case "$resume_count" in ''|*[!0-9]*) printf '%s\n' "OPENAI_CODEX_RESUME_COUNT must be non-negative" >&2; exit 2 ;; esac
case "$attempt" in ''|*[!0-9]*|0|0[0-9]*) printf '%s\n' "OPENAI_CODEX_ATTEMPT must be a positive integer" >&2; exit 2 ;; esac
recovery_file=""
recovery_lock=""
recovery_home_root=${OPENAI_TEAM_RECOVERY_HOME_ROOT:-/tmp}
[ -z "$fingerprint" ] || { mkdir -p "$root/codex-recovery" "$root/locks"; chmod 0700 "$root/codex-recovery" "$root/locks"; recovery_file="$root/codex-recovery/$fingerprint.json"; recovery_lock="$root/codex-recovery/.$fingerprint.lock"; }
resume_expected_version=${OPENAI_CODEX_RECOVERY_EXPECTED_VERSION:-}
if [ -n "$resume_thread_id" ]; then
  case "$resume_expected_version" in ''|*[!0-9]*|0|0[0-9]*)
    jq -cn --arg task_id "$fingerprint" '{code:"RECOVERY_SIDE_EFFECT_REVIEW_REQUIRED",retryable:false,provider_failure:false,phase:"recovery",task_id:$task_id,fingerprint:$task_id,attempt:null,version:null,mutation_count:0,journal_incomplete:true}'
    exit 73
    ;;
  esac
  resume_record=$(jq -c . "$recovery_file" 2>/dev/null || printf '')
  if [ -z "$resume_record" ] || [ "$(printf '%s' "$resume_record" | jq -r --arg fingerprint "$fingerprint" --arg thread "$resume_thread_id" --argjson attempt "$attempt" --argjson version "$resume_expected_version" '.fingerprint != $fingerprint or .thread_id != $thread or .attempt != ($attempt - 1) or .version != $version or .termination_sealed != true or .journal_scan_complete != true or .journal_incomplete == true or (.command_journal // []) != [] or .sealed_run_id != .codex_run_id or .sealed_lease_id != .task_lease_id')" ] || [ "$(printf '%s' "$resume_record" | jq -r '.termination_sealed == true and .journal_scan_complete == true and (.command_journal // []) == []')" != true ]; then
    jq -cn --arg task_id "$fingerprint" '{code:"RECOVERY_SIDE_EFFECT_REVIEW_REQUIRED",retryable:false,provider_failure:false,phase:"recovery",task_id:$task_id,fingerprint:$task_id,attempt:null,version:null,mutation_count:0,journal_incomplete:true}'
    exit 73
  fi
  resume_journal=$(printf '%s' "$resume_record" | jq -c '.command_journal // []')
  resume_incomplete=$(printf '%s' "$resume_record" | jq -r '.journal_incomplete == true')
  if [ "$resume_journal" != '[]' ] || [ "$resume_incomplete" = true ]; then
    printf '%s' "$resume_record" | jq -c '{code:"RECOVERY_SIDE_EFFECT_REVIEW_REQUIRED",retryable:false,provider_failure:false,phase:"recovery",task_id:.fingerprint,fingerprint:.fingerprint,attempt:.attempt,version:.version,mutation_count:(.command_journal|length),journal_incomplete:(.journal_incomplete == true)}'
    exit 73
  fi
fi
latency_log="$root/logs/latency-metrics.jsonl"
touch "$latency_log"
chmod 0600 "$latency_log"
millis() { perl -MTime::HiRes=time -e 'printf "%.0f\n", time * 1000'; }
lock_mtime_ms() { local seconds; seconds=$(stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || printf '0'); printf '%s000\n' "$seconds"; }
process_start_identity() { ps -o lstart= -p "$1" 2>/dev/null | awk '{$1=$1; print}' | tr -s ' '; }
process_identity=$(process_start_identity "$$" || true)
lock_orphan_grace_ms=${OPENAI_LOCK_ORPHAN_GRACE_MS:-1000}
case "$lock_orphan_grace_ms" in ''|*[!0-9]*) lock_orphan_grace_ms=1000;; esac
lane_started=$(millis)
append_latency() {
  local stage=$1 outcome=$2 exit_status=$3 provider_failure=$4 duration_ms=$5 event_count=$6
  jq -nc --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg stage "$stage" --arg outcome "$outcome" \
    --arg model "${OPENAI_CODEX_MODEL:-}" --arg requested_model "$requested_model" --arg executed_model "$model" --arg fallback_model "$fallback_model" --arg fallback_reason "$fallback_reason" --arg profile "$profile" --arg effort "$reasoning_effort" --arg run "${run_id:-}" \
     --argjson fallback_count "$fallback_count" --argjson fallback_eligible "$fallback_eligible" --argjson exit_status "$exit_status" --argjson provider_failure "$provider_failure" --argjson duration_ms "$duration_ms" --argjson event_count "$event_count" --argjson mutation_count "${journal_mutation_count:-0}" --argjson journal_incomplete "$journal_incomplete" \
    --argjson input_tokens "${input_tokens:-0}" --argjson cached_input_tokens "${cached_input_tokens:-0}" --argjson cache_write_input_tokens "${cache_write_input_tokens:-0}" --argjson output_tokens "${output_tokens:-0}" --argjson reasoning_tokens "${reasoning_tokens:-0}" --argjson total_tokens "${total_tokens:-0}" \
    --argjson threshold_tokens "$token_threshold" \
     '{schema_version:3,timestamp:$timestamp,stage:$stage,outcome:$outcome,duration_ms:$duration_ms,agent:"codex_executor",model:(if $executed_model == "" then null else $executed_model end),requested_model:(if $requested_model == "" then null else $requested_model end),executed_model:(if $executed_model == "" then null else $executed_model end),fallback_model:(if $fallback_model == "" then null else $fallback_model end),fallback_reason:(if $fallback_reason == "" then null else $fallback_reason end),fallback_count:$fallback_count,fallback_eligible:($fallback_eligible == 1),profile:$profile,reasoning_effort:$effort,exit_status:$exit_status,provider_failure:($provider_failure == 1),event_count:$event_count,mutation_count:$mutation_count,journal_incomplete:($journal_incomplete == 1),run_id:(if $run == "" then null else $run end)} + (if $stage == "codex_cli" then {input_tokens:$input_tokens,cached_input_tokens:$cached_input_tokens,cache_write_input_tokens:$cache_write_input_tokens,output_tokens:$output_tokens,reasoning_tokens:$reasoning_tokens,total_tokens:$total_tokens,threshold_tokens:$threshold_tokens,overage_tokens:([$input_tokens-$threshold_tokens,0]|max),cache_ratio_pct:(if $input_tokens + $cached_input_tokens > 0 then ($cached_input_tokens / ($input_tokens + $cached_input_tokens) * 100) else 0 end),budget_status:(if $input_tokens > $threshold_tokens then "exceeded" else "within" end)} else {} end)' >> "$latency_log"
}

model_key=$(printf '%s' "$model" | shasum -a 256 | awk '{print $1}')
state="$root/codex/circuit-$model_key.json"
state_tmp="$state.$invocation_id.tmp"
now=$(date +%s)
breaker_lock="$root/locks/circuit-$model_key.lock"
breaker_owner="$(openssl rand -hex 16)"
 breaker_lease=${OPENAI_LOCK_LEASE_SECONDS:-30}; case "$breaker_lease" in ''|*[!0-9]*|0) breaker_lease=30;; esac; [ "$breaker_lease" -gt 300 ] && breaker_lease=300; export OPENAI_LOCK_LEASE_SECONDS="$breaker_lease"
  reclaim_mutex_enter() { local lock=$1 token=$2 deadline=$((SECONDS + ${OPENAI_LOCK_WAIT_SECONDS:-5})) mutex="$lock.reclaim"; while [ "$SECONDS" -lt "$deadline" ]; do if mkdir "$mutex" 2>/dev/null; then jq -n --arg token "$token" --arg start "$process_identity" --argjson pid "$$" --argjson acquired_at "$(millis)" --argjson lease_ms "$((breaker_lease * 1000))" '{token:$token,pid:$pid,process_start_identity:$start,acquired_at:$acquired_at,heartbeat_at:$acquired_at,lease_ms:$lease_ms}' > "$mutex/owner.json"; return 0; fi; sleep 0.02; done; return 1; }
reclaim_mutex_leave() { local lock=$1 token=$2 mutex="$lock.reclaim" fenced current; current=$(jq -r '.token // empty' "$mutex/owner.json" 2>/dev/null || true); [ "$current" = "$token" ] || return 0; fenced="$mutex.release.$token"; perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$mutex" "$fenced" 2>/dev/null || return 0; if [ "$(jq -r '.token // empty' "$fenced/owner.json" 2>/dev/null || true)" = "$token" ]; then rm -rf "$fenced"; else perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$fenced" "$mutex" 2>/dev/null || true; fi; }
 serialized_reclaim() { local lock=$1 captured=$2 token=$3 moved="$lock.stale.$token" current moved_owner; [ -n "$captured" ] || captured=$(cat "$lock/owner.json" 2>/dev/null || true); reclaim_mutex_enter "$lock" "$token" || return 1; current=$(cat "$lock/owner.json" 2>/dev/null || true); if [ "$current" != "$captured" ]; then reclaim_mutex_leave "$lock" "$token"; return 0; fi; if [ -n "$current" ]; then pid=$(printf '%s' "$current" | jq -r '.pid // empty'); start=$(printf '%s' "$current" | jq -r '.process_start_identity // empty'); current_identity=$(process_start_identity "$pid" || true); if kill -0 "$pid" 2>/dev/null && { [ -z "$current_identity" ] || [ "$current_identity" = "$start" ]; } && [ -n "$current_identity" ]; then reclaim_mutex_leave "$lock" "$token"; return 0; fi; fi; perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$lock" "$moved" 2>/dev/null || { reclaim_mutex_leave "$lock" "$token"; return 1; }; moved_owner=$(cat "$moved/owner.json" 2>/dev/null || true); if [ "$moved_owner" = "$captured" ]; then rm -rf "$moved"; elif [ ! -e "$lock" ]; then perl -e 'rename($ARGV[0], "$ARGV[1]") or exit 1' "$moved" "$lock" 2>/dev/null || true; else :; fi; reclaim_mutex_leave "$lock" "$token"; }
acquire_breaker_lock() { local deadline=$((SECONDS + ${OPENAI_LOCK_WAIT_SECONDS:-5})) stale pid token fenced stage age current_identity; while :; do stage="$breaker_lock.acquire.$breaker_owner.$RANDOM"; if [ ! -e "$breaker_lock.reclaim" ] && [ ! -e "$breaker_lock" ] && mkdir "$stage" 2>/dev/null; then jq -n --arg token "$breaker_owner" --arg start "$process_identity" --argjson pid "$$" --argjson acquired_at "$(millis)" --argjson lease_ms "$((breaker_lease * 1000))" '{token:$token,pid:$pid,process_start_identity:$start,acquired_at:$acquired_at,heartbeat_at:$acquired_at,lease_ms:$lease_ms}' > "$stage/owner.json"; if perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$stage" "$breaker_lock" 2>/dev/null; then return 0; fi; rm -rf "$stage"; fi; pid=$(jq -r '.pid // empty' "$breaker_lock/owner.json" 2>/dev/null || true); if [ -n "$pid" ]; then current_identity=$(process_start_identity "$pid" || true); if ! kill -0 "$pid" 2>/dev/null || { [ -n "$current_identity" ] && [ "$current_identity" != "$(jq -r '.process_start_identity // empty' "$breaker_lock/owner.json" 2>/dev/null || true)" ]; } || { [ -z "$current_identity" ] && [ "$(millis)" -ge "$(jq -r '((.heartbeat_at // .acquired_at // 0) + ((.lease_ms // 30000)) + 1000)' "$breaker_lock/owner.json" 2>/dev/null || echo 0)" ]; }; then serialized_reclaim "$breaker_lock" "$(cat "$breaker_lock/owner.json" 2>/dev/null || true)" "$breaker_owner.$RANDOM" || true; fi; else age=$(( $(millis) - $(lock_mtime_ms "$breaker_lock") )); [ "$age" -lt "$lock_orphan_grace_ms" ] || serialized_reclaim "$breaker_lock" "" "$breaker_owner.$RANDOM" || true; fi; [ "$SECONDS" -lt "$deadline" ] || { echo "OPENAI_LOCK_TIMEOUT circuit.lock" >&2; return 75; }; sleep 0.05; done; }
 release_breaker_lock() { [ "$(jq -r '.token // empty' "$breaker_lock/owner.json" 2>/dev/null || true)" = "$breaker_owner" ] || return 0; fenced="$breaker_lock.release.$breaker_owner"; mv "$breaker_lock" "$fenced" 2>/dev/null || return 0; if [ "$(jq -r '.token // empty' "$fenced/owner.json" 2>/dev/null || true)" = "$breaker_owner" ]; then rm -rf "$fenced"; else mv "$fenced" "$breaker_lock" 2>/dev/null || true; fi; }
acquire_breaker_lock
trap release_breaker_lock EXIT
if [ ! -f "$state" ]; then
  jq -n --arg model "$model" '{state:"CLOSED",model:$model,failures:0,generation:0,opened_at:null,cooldown_seconds:0,last_reason:null}' > "$state"
  chmod 0600 "$state"
fi
circuit=$(jq -r '.state' "$state")
start_generation=$(jq -r '(.generation // 0) | if type == "number" and . >= 0 then . else 0 end' "$state")
probe_attempt=0
opened=$(jq -r '.opened_at // 0' "$state")
cooldown=$(jq -r '.cooldown_seconds // 0' "$state")
lane_timeout=${OPENAI_CODEX_TIMEOUT_SECONDS:-900}; case "$lane_timeout" in ''|*[!0-9]*|0) lane_timeout=900;; esac; [ "$lane_timeout" -gt 3600 ] && lane_timeout=3600
probe_lease=$lane_timeout; [ "$probe_lease" -lt 30 ] && probe_lease=30

if [ "$circuit" = OPEN ] && [ "$((now - opened))" -lt "$cooldown" ]; then
  jq -cn --arg invocation_id "$invocation_id" --arg model "$model" --arg profile "$profile" --arg requested_model "$requested_model" --arg fallback_model "$fallback_model" --arg reason "$(jq -r '.last_reason // "provider_failure"' "$state")" --argjson fallback_count "$fallback_count" --argjson cooldown "$cooldown" '{schema_version:3,code:"CODEX_MODEL_CIRCUIT_OPEN",invocation_id:$invocation_id,provider_failure:true,fallback_eligible:true,model:$model,executed_model:$model,profile:$profile,requested_model:$requested_model,fallback_model:(if $fallback_model=="" then null else $fallback_model end),fallback_count:$fallback_count,fallback_reason:$reason,cooldown_seconds:$cooldown}'
  append_latency codex_cli provider_failure 78 1 "$(( $(millis) - lane_started ))" 0
  exit 78
fi
if [ "$circuit" = HALF_OPEN ]; then
  probe_until=$(jq -r '.probe_lease_until // 0' "$state")
  if [ "$probe_until" -gt "$(date +%s)" ]; then
    jq -cn --arg invocation_id "$invocation_id" --arg model "$model" --arg profile "$profile" --arg requested_model "$requested_model" --arg fallback_model "$fallback_model" --argjson fallback_count "$fallback_count" '{schema_version:3,code:"CODEX_MODEL_CIRCUIT_OPEN",invocation_id:$invocation_id,provider_failure:true,fallback_eligible:true,model:$model,executed_model:$model,profile:$profile,requested_model:$requested_model,fallback_model:(if $fallback_model=="" then null else $fallback_model end),fallback_count:$fallback_count,fallback_reason:"circuit_open",cooldown_seconds:0}'
    append_latency codex_cli provider_failure 78 1 "$(( $(millis) - lane_started ))" 0; exit 78
  fi
   jq --arg owner "$invocation_id" --argjson lease_until "$(( $(date +%s) + probe_lease ))" '.state="HALF_OPEN" | .probe_owner=$owner | .probe_lease_until=$lease_until' "$state" > "$state_tmp" && mv "$state_tmp" "$state"
  probe_attempt=1
fi
if [ "$circuit" = OPEN ]; then
  jq --argjson now "$now" --arg owner "$invocation_id" --argjson lease_until "$(( now + probe_lease ))" '.state="HALF_OPEN" | .probe_owner=$owner | .probe_lease_until=$lease_until' "$state" > "$state_tmp" && mv "$state_tmp" "$state"
  probe_attempt=1
fi
release_breaker_lock
trap - EXIT

run_id=$(openssl rand -hex 8)
out="$root/codex/$run_id.jsonl"
stderr_file="$root/codex/$run_id.stderr"
handoff="$root/handoffs/$run_id.json"
status_file="$root/handoffs/$run_id.git-status"
diff_file="$root/handoffs/$run_id.git-diff"
cached_diff_file="$root/handoffs/$run_id.git-cached-diff"
changed_file="$root/handoffs/$run_id.changed-files"
touch "$out" "$stderr_file"
chmod 0600 "$out" "$stderr_file"
journal_scan_offset=0
journal_pending=()
journal_incomplete=0
journal_mutation_count=0
journal_max_bytes=${OPENAI_CODEX_JOURNAL_MAX_BYTES:-1048576}
journal_max_events=${OPENAI_CODEX_JOURNAL_MAX_EVENTS:-1024}
scan_command_journal() {
  local final=${1:-false}
  [ -f "$out" ] || { [ "$final" = true ] && journal_incomplete=1; return 0; }
  local scan hash
  scan=$(node "$(dirname "$0")/openai-journal-scan.mjs" "$out" "$journal_scan_offset" "$journal_max_bytes" "$journal_max_events") || { journal_incomplete=1; return 0; }
  journal_scan_offset=$(printf '%s' "$scan" | jq -r '.offset')
  [ "$(printf '%s' "$scan" | jq -r '.incomplete == true')" != true ] || journal_incomplete=1
  [ "$final" != true ] || [ "$(printf '%s' "$scan" | jq -r '.partial_tail == true')" != true ] || journal_incomplete=1
  while IFS= read -r hash; do [ -z "$hash" ] || journal_pending+=("$hash"); done < <(printf '%s' "$scan" | jq -r '.hashes[]')
  if [ "$final" = true ]; then
    scan=$(node "$(dirname "$0")/openai-journal-scan.mjs" "$out" 0 "$journal_max_bytes" "$journal_max_events") || { journal_incomplete=1; return 0; }
    [ "$(printf '%s' "$scan" | jq -r '.incomplete == true or .partial_tail == true')" != true ] || journal_incomplete=1
    journal_mutation_count=$(printf '%s' "$scan" | jq '[.hashes[]] | unique | length' 2>/dev/null || printf '0')
  fi
}

cli_started=$(millis)
execution_task="$task

Efficiency contract:
- Start from files and symbols explicitly named in the objective.
- Avoid broad repository inventories and full-file dumps when targeted reads suffice.
- Batch independent reads and checks.
- Do not retry the same failed or environment-blocked probe.
- Run only focused tests unless the full suite is explicitly requested.
  - Stop after requested verification and concise summary."
resume_prompt="Inspect the current workspace and continue the objective."
persist_recovery() {
  local thread_id=$1 recovery_state=$2 final=${3:-false} temporary owner now deadline current_token current_attempt current_resume current_version next_version expected_version journal stage lock_token owner_pid age
  [ -n "$recovery_file" ] && [ -n "$thread_id" ] || return 0
  scan_command_journal "$final"
  owner="${run_id:-lane}-$$-$(millis)"; now=$(millis); deadline=$((now + 5000)); lock_token="$owner"
  while :; do
    stage="$recovery_lock.acquire.$lock_token.$RANDOM"
     if [ ! -e "$recovery_lock.reclaim" ] && [ ! -e "$recovery_lock" ] && mkdir "$stage" 2>/dev/null; then
      jq -n --arg token "$lock_token" --arg start "$process_identity" --argjson pid "$$" --argjson now "$(millis)" '{token:$token,pid:$pid,process_start_identity:$start,acquired_at:$now,heartbeat_at:$now,lease_ms:30000}' > "$stage/owner.json" && chmod 0600 "$stage/owner.json"
      if perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$stage" "$recovery_lock" 2>/dev/null; then break; fi
      rm -rf "$stage"
    fi
    current_token=$(jq -r '.token // empty' "$recovery_lock/owner.json" 2>/dev/null || true)
    owner_pid=$(jq -r '.pid // empty' "$recovery_lock/owner.json" 2>/dev/null || true)
    owner_start=$(jq -r '.process_start_identity // empty' "$recovery_lock/owner.json" 2>/dev/null || true)
    current_start=$(process_start_identity "$owner_pid" || true)
    if [ -n "$owner_pid" ] && { ! kill -0 "$owner_pid" 2>/dev/null || { [ -n "$current_start" ] && [ "$current_start" != "$owner_start" ]; } || { [ -z "$current_start" ] && [ "$(millis)" -ge "$(jq -r '((.heartbeat_at // .acquired_at // 0) + (.lease_ms // 30000) + 1000)' "$recovery_lock/owner.json" 2>/dev/null || echo 0)" ]; }; }; then
      serialized_reclaim "$recovery_lock" "$(cat "$recovery_lock/owner.json" 2>/dev/null || true)" "$owner.$RANDOM" || true
      continue
    fi
    if [ -z "$owner_pid" ]; then
      age=$(( $(millis) - $(lock_mtime_ms "$recovery_lock") ))
      if [ "$age" -ge "$lock_orphan_grace_ms" ]; then
      serialized_reclaim "$recovery_lock" "$(cat "$recovery_lock/owner.json" 2>/dev/null || true)" "$owner.$RANDOM" || true
        continue
      fi
    fi
    [ "$(millis)" -lt "$deadline" ] || return 75
    sleep 0.02
  done
  current_attempt=$(jq -r '.attempt // 0' "$recovery_file" 2>/dev/null || printf '0')
  current_resume=$(jq -r '.resume_count // 0' "$recovery_file" 2>/dev/null || printf '0')
  current_version=$(jq -r '.version // 0' "$recovery_file" 2>/dev/null || printf '0')
  expected_version=${OPENAI_CODEX_RECOVERY_EXPECTED_VERSION:-}
  if [ "$attempt" -lt "$current_attempt" ] || [ "$resume_count" -lt "$current_resume" ] || { [ "$attempt" -eq "$current_attempt" ] && [ "$resume_count" -eq "$current_resume" ] && { [ "$(jq -r '.thread_id // empty' "$recovery_file" 2>/dev/null || true)" != "$thread_id" ] || [ "$(jq -r '.codex_run_id // empty' "$recovery_file" 2>/dev/null || true)" != "$run_id" ]; }; } || { [ -n "$expected_version" ] && [ "$current_attempt" -lt "$attempt" ] && [ "$expected_version" != "$current_version" ]; }; then
     current_token=$(jq -r '.token // empty' "$recovery_lock/owner.json" 2>/dev/null || true); if [ "$current_token" = "$owner" ]; then fenced="$recovery_lock.release.$owner"; mv "$recovery_lock" "$fenced" 2>/dev/null && { [ "$(jq -r '.token // empty' "$fenced/owner.json" 2>/dev/null || true)" = "$owner" ] && rm -rf "$fenced" || mv "$fenced" "$recovery_lock" 2>/dev/null || true; }; fi; return 76
  fi
  next_version=$((current_version + 1)); temporary="$recovery_file.$owner.tmp"; journal=$(jq -c '.command_journal // []' "$recovery_file" 2>/dev/null || printf '[]'); for hash in "${journal_pending[@]:-}"; do [ -n "$hash" ] || continue; journal=$(jq -cn --argjson j "$journal" --arg h "$hash" '$j + [$h] | unique | .[-256:]'); done
  current_incomplete=$(jq -r '.journal_incomplete == true' "$recovery_file" 2>/dev/null || printf false)
   sealed=0; [ "$final" = true ] && { [ "$journal_incomplete" -eq 0 ] && [ "$journal_mutation_count" -eq 0 ] && sealed=1; }
   jq -n --arg fingerprint "$fingerprint" --arg lease "${OPENAI_CODEX_TASK_LEASE_ID:-}" --arg thread "$thread_id" --arg run "$run_id" --arg parent "$parent_codex_run_id" --arg home "${CODEX_HOME:-}" --arg home_root "$recovery_home_root" --arg state "$recovery_state" --argjson attempt "$attempt" --argjson count "$resume_count" --argjson version "$next_version" --argjson journal "$journal" --argjson incomplete "$journal_incomplete" --argjson old_incomplete "$current_incomplete" --argjson sealed "$sealed" \
    '{schema_version:1,version:$version,fingerprint:$fingerprint,attempt:$attempt,task_lease_id:(if $lease=="" then null else $lease end),thread_id:$thread,codex_run_id:$run,parent_codex_run_id:(if $parent=="" then null else $parent end),codex_home:(if ($home|startswith($home_root+"/codex-home-")) then $home else null end),codex_home_identity:(if ($home|startswith($home_root+"/codex-home-")) then $home else null end),resume_count:$count,state:$state,journal_incomplete:(($incomplete == 1) or $old_incomplete),journal_scan_complete:($sealed == 1),termination_sealed:($sealed == 1),sealed_run_id:(if $sealed == 1 then $run else null end),sealed_lease_id:(if $sealed == 1 and $lease != "" then $lease else null end),command_journal:$journal}' > "$temporary" && chmod 0600 "$temporary" && mv "$temporary" "$recovery_file" && chmod 0600 "$recovery_file"; journal_pending=()
   current_token=$(jq -r '.token // empty' "$recovery_lock/owner.json" 2>/dev/null || true)
   if [ "$current_token" = "$owner" ]; then fenced="$recovery_lock.release.$owner"; mv "$recovery_lock" "$fenced" 2>/dev/null && { [ "$(jq -r '.token // empty' "$fenced/owner.json" 2>/dev/null || true)" = "$owner" ] && rm -rf "$fenced" || mv "$fenced" "$recovery_lock" 2>/dev/null || true; }; fi
}
thread_id=""
discover_thread() {
  [ -n "$thread_id" ] && return 0
  thread_id=$(jq -r 'select(.type == "thread.started" and (.thread_id|type == "string") and (.thread_id|length > 0)) | .thread_id' "$out" 2>/dev/null | head -n 1 || true)
  [ -z "$thread_id" ] || persist_recovery "$thread_id" running
}
cleanup_child() {
  discover_thread
  [ -z "${codex_pid:-}" ] || kill -TERM -- "-$codex_pid" 2>/dev/null || kill -TERM "$codex_pid" 2>/dev/null || true
  [ -z "${codex_pid:-}" ] || wait "$codex_pid" 2>/dev/null || true
  scan_command_journal true
  [ -z "$thread_id" ] || persist_recovery "$thread_id" interrupted true || true
}
trap 'cleanup_child; exit 143' TERM
trap 'cleanup_child; exit 130' INT
set +e
codex_args=(exec)
if [ -n "$resume_thread_id" ]; then codex_args+=(resume --model "${OPENAI_CODEX_MODEL:?OPENAI_CODEX_MODEL is required}" -c "model_reasoning_effort=$reasoning_effort" -c "model_auto_compact_token_limit=$compact_token_limit" -c "compact_prompt=\"$compact_prompt\"" --skip-git-repo-check --json "$resume_thread_id" "$resume_prompt")
else codex_args+=(--model "${OPENAI_CODEX_MODEL:?OPENAI_CODEX_MODEL is required}" -c "model_reasoning_effort=$reasoning_effort" -c "model_auto_compact_token_limit=$compact_token_limit" -c "compact_prompt=\"$compact_prompt\"" --skip-git-repo-check --json --sandbox workspace-write "$execution_task"); fi
(cd "$repo" && CODEX_HOME="${CODEX_HOME:?CODEX_HOME is required}" "${OPENAI_CODEX_BIN:-codex}" "${codex_args[@]}") > "$out" 2> "$stderr_file" &
codex_pid=$!
last_heartbeat=$(date +%s)
printf '%s\n' '{"type":"codex_progress","status":"running"}'
while kill -0 "$codex_pid" 2>/dev/null; do
  now=$(date +%s)
  discover_thread
  [ -z "$thread_id" ] || persist_recovery "$thread_id" running || true
  if [ "$((now - last_heartbeat))" -ge 5 ]; then
    printf '%s\n' '{"type":"codex_progress","status":"running"}'
    last_heartbeat=$now
  fi
  sleep 0.2
done
wait "$codex_pid"
status=$?
set -e
trap - TERM INT
scan_command_journal true
discover_thread
cli_elapsed="$(( $(millis) - cli_started ))"

handoff_started=$(millis)
(cd "$repo" && git status --short) > "$status_file" 2>/dev/null || true
(cd "$repo" && git diff --no-ext-diff --binary -- . ':(exclude)*.env' ':(exclude)*.env.*') > "$diff_file" 2>/dev/null || true
(cd "$repo" && git diff --cached --no-ext-diff --binary -- . ':(exclude)*.env' ':(exclude)*.env.*') > "$cached_diff_file" 2>/dev/null || true
(cd "$repo" && git status --short | cut -c4-) > "$changed_file" 2>/dev/null || true
chmod 0600 "$status_file" "$diff_file" "$cached_diff_file" "$changed_file"

provider_failure=0
fallback_eligible=0
fallback_reason=$fallback_reason_from_parent
reason=task_failure
if [ "$status" -eq 0 ] && jq -s -e 'any(.[]; .type == "turn.completed")' "$out" >/dev/null 2>&1; then
  reason=success
elif [ -s "$stderr_file" ] || jq -s -e 'any(.[]; ((.type == "error" or .type == "turn.failed") and (((.error.code // "") + " " + (.error.message // "") + " " + (.message // "")) | test("auth|unauthorized|invalid key|billing|global[- ]?credit|quota|rate.?limit|429|capacity|unavailable|timeout|transport|network|connection|econn|temporary|5[0-9][0-9]|invalid request|bad request|malformed|abort|cancel"; "i"))))' "$out" >/dev/null 2>&1; then
  detail="$(jq -rs '[.[] | select(.type == "error" or .type == "turn.failed") | ((.error.code // "") + " " + (.error.message // "") + " " + (.message // ""))] | join(" ")' "$out" 2>/dev/null || true) $(cat "$stderr_file" 2>/dev/null || true)"
  if printf '%s' "$detail" | grep -Eiq 'abort|cancel'; then reason=aborted; elif printf '%s' "$detail" | grep -Eiq 'auth|unauthori[sz]ed|invalid key|billing|global[- ]?credit|invalid request|bad request|invalid|malformed|validation'; then reason=unsafe_request_or_account; provider_failure=1; elif printf '%s' "$detail" | grep -Eiq 'quota'; then reason=quota; fallback_eligible=1; fallback_reason=quota; provider_failure=1; elif printf '%s' "$detail" | grep -Eiq 'rate.?limit|429'; then reason=rate_limit; fallback_eligible=1; fallback_reason=rate_limit; provider_failure=1; elif printf '%s' "$detail" | grep -Eiq 'capacity'; then reason=capacity; fallback_eligible=1; fallback_reason=capacity; provider_failure=1; elif printf '%s' "$detail" | grep -Eiq 'model.*(not found|unavailable)|unavailable'; then reason=model_unavailable; fallback_eligible=1; fallback_reason=model_unavailable; provider_failure=1; elif printf '%s' "$detail" | grep -Eiq 'timeout|transport|network|connection|econn|5[0-9][0-9]|temporary'; then reason=temporary_transport; fallback_eligible=1; fallback_reason=temporary_transport; provider_failure=1; else reason=process_failure_unknown; fi
elif [ -s "$stderr_file" ]; then
  reason=process_failure_unknown
elif [ ! -s "$out" ]; then
  reason=process_failure_unknown
fi
[ "$fallback_eligible" -eq 0 ] || { if [ -n "${OPENAI_CODEX_COOLDOWN_SECONDS:-}" ]; then cooldown=${OPENAI_CODEX_COOLDOWN_SECONDS}; elif [ "$fallback_reason" = rate_limit ]; then cooldown=900; elif [ "$fallback_reason" = model_unavailable ]; then cooldown=1800; else cooldown=300; fi; }
 [ -z "$thread_id" ] || persist_recovery "$thread_id" "$reason" true

event_count=$(jq -s 'length' "$out" 2>/dev/null || printf '0')
input_tokens=$(jq -s '[.[] | select(.type == "turn.completed") | .usage.input_tokens // 0 | if type == "number" then . else 0 end] | add // 0' "$out" 2>/dev/null || printf '0')
cached_input_tokens=$(jq -s '[.[] | select(.type == "turn.completed") | .usage.cached_input_tokens // 0 | if type == "number" then . else 0 end] | add // 0' "$out" 2>/dev/null || printf '0')
cache_write_input_tokens=$(jq -s '[.[] | select(.type == "turn.completed") | .usage.cache_write_input_tokens // 0 | if type == "number" then . else 0 end] | add // 0' "$out" 2>/dev/null || printf '0')
output_tokens=$(jq -s '[.[] | select(.type == "turn.completed") | .usage.output_tokens // 0 | if type == "number" then . else 0 end] | add // 0' "$out" 2>/dev/null || printf '0')
reasoning_tokens=$(jq -s '[.[] | select(.type == "turn.completed") | .usage.reasoning_output_tokens // 0 | if type == "number" then . else 0 end] | add // 0' "$out" 2>/dev/null || printf '0')
total_tokens=$((input_tokens + cached_input_tokens + cache_write_input_tokens + output_tokens + reasoning_tokens))

jq -n \
  --arg run "$run_id" --arg invocation_id "$invocation_id" --arg status "$status" \
  --arg reason "$reason" \
  --arg thread "$thread_id" --arg parent "$parent_codex_run_id" --arg lease "${OPENAI_CODEX_TASK_LEASE_ID:-}" --arg model "$model" --arg profile "$profile" --arg requested_model "$requested_model" --arg fallback_model "$fallback_model" --arg fallback_reason "$fallback_reason" --argjson fallback_count "$fallback_count" --argjson fallback_eligible "$fallback_eligible" --argjson cooldown "$cooldown" --argjson resume_count "$resume_count" --argjson attempt "$attempt" --argjson provider_failure "$provider_failure" \
  --argjson mutation_count "${journal_mutation_count:-0}" --argjson journal_incomplete "$journal_incomplete" --argjson input_tokens "${input_tokens:-0}" --argjson cached_input_tokens "${cached_input_tokens:-0}" --argjson cache_write_input_tokens "${cache_write_input_tokens:-0}" --argjson output_tokens "${output_tokens:-0}" --argjson reasoning_tokens "${reasoning_tokens:-0}" --argjson total_tokens "${total_tokens:-0}" \
  '{schema_version:3,invocation_id:$invocation_id,codex_run_id:$run,thread_id:(if $thread=="" then null else $thread end),parent_codex_run_id:(if $parent=="" then null else $parent end),model:$model,profile:$profile,requested_model:$requested_model,executed_model:$model,fallback_model:(if $fallback_model=="" then null else $fallback_model end),fallback_count:$fallback_count,fallback_eligible:($fallback_eligible == 1 and $journal_incomplete == 0 and $mutation_count == 0),fallback_reason:(if $fallback_reason=="" then null else $fallback_reason end),cooldown_seconds:$cooldown,resume_count:$resume_count,attempt:$attempt,exit_status:($status|tonumber),reason:$reason,provider_failure:$provider_failure,mutation_count:$mutation_count,journal_incomplete:($journal_incomplete == 1),termination_sealed:true,journal_scan_complete:($journal_incomplete == 0),sealed_run_id:$run,sealed_lease_id:(if $lease == "" then null else $lease end),token_usage:{input_tokens:$input_tokens,cached_input_tokens:$cached_input_tokens,cache_write_input_tokens:$cache_write_input_tokens,output_tokens:$output_tokens,reasoning_tokens:$reasoning_tokens,total_tokens:$total_tokens}}' > "$handoff"
chmod 0600 "$handoff"
handoff_elapsed="$(( $(millis) - handoff_started ))"
append_latency codex_cli "$reason" "$status" "$provider_failure" "$cli_elapsed" "$event_count"
append_latency codex_handoff "$reason" "$status" "$provider_failure" "$handoff_elapsed" "$event_count"

if [ "$fallback_eligible" -eq 1 ]; then
  set +e
  if ! acquire_breaker_lock; then
    printf '%s\n' "BREAKER_LOCK_DEFERRED reason=$reason run=$run_id" >> "$root/logs/codex.log"
    printf '%s\n' "$handoff"
    exit 79
  fi
  opened_at=$(date +%s)
    if ! jq --arg reason "$reason" --arg invocation_id "$invocation_id" --arg profile "$profile" --arg requested_model "$requested_model" --argjson fallback_count "$fallback_count" --argjson opened_at "$opened_at" --argjson cooldown "$cooldown" --argjson start_generation "$start_generation" 'if ((.generation // 0) == $start_generation) and (.state != "HALF_OPEN" or .probe_owner == $invocation_id) then (.state="OPEN" | .failures=(.failures // 0)+1 | .generation=((.generation // 0) + 1) | .opened_at=$opened_at | .cooldown_seconds=$cooldown | .last_reason=$reason | .invocation_id=$invocation_id | .profile=$profile | .requested_model=$requested_model | .fallback_count=$fallback_count | .probe_owner=null | .probe_lease_until=null) else . end' "$state" > "$state_tmp"; then
      rm -f "$state_tmp"
      release_breaker_lock
      exit 79
    fi
    mv "$state_tmp" "$state"
  release_breaker_lock
  set -e
  printf '%s\n' "BREAKER OPEN reason=$reason run=$run_id" >> "$root/logs/codex.log"
  printf '%s\n' "$handoff"
  exit 79
fi

if [ "$status" -eq 0 ]; then
  acquire_breaker_lock
   jq --arg owner "$invocation_id" --argjson start_generation "$start_generation" 'if .probe_owner == $owner or (.state != "HALF_OPEN" and .state != "OPEN" and ((.generation // 0) == $start_generation)) then (.state="CLOSED" | .failures=0 | .generation=(if (.generation // 0) < 0 then 0 else (.generation // 0) end) | .opened_at=null | .last_reason=null | .probe_owner=null | .probe_lease_until=null) else . end' "$state" > "$state_tmp" && mv "$state_tmp" "$state"
  release_breaker_lock
  printf '%s\n' "BREAKER CLOSED run=$run_id" >> "$root/logs/codex.log"
elif [ "$probe_attempt" -eq 1 ]; then
  acquire_breaker_lock
  if [ -s "$out" ] && jq -s -e 'length > 0' "$out" >/dev/null 2>&1; then
     jq --arg reason "$reason" --arg owner "$invocation_id" 'if .probe_owner == $owner then (.state="CLOSED" | .failures=0 | .opened_at=null | .last_reason=$reason | .probe_owner=null | .probe_lease_until=null) else . end' "$state" > "$state_tmp" && mv "$state_tmp" "$state"
    printf '%s\n' "HALF_OPEN task failure proved provider health; BREAKER CLOSED run=$run_id" >> "$root/logs/codex.log"
  else
    opened_at=$(date +%s)
     jq --arg reason "unknown_probe_failure" --argjson opened_at "$opened_at" --arg owner "$invocation_id" 'if .probe_owner == $owner then (.state="OPEN" | .generation=((.generation // 0) + 1) | .opened_at=$opened_at | .last_reason=$reason | .probe_owner=null | .probe_lease_until=null) else . end' "$state" > "$state_tmp" && mv "$state_tmp" "$state"
    printf '%s\n' "HALF_OPEN unknown failure; BREAKER OPEN run=$run_id" >> "$root/logs/codex.log"
  fi
  release_breaker_lock
else
  printf '%s\n' "TASK FAILURE breaker unchanged run=$run_id" >> "$root/logs/codex.log"
fi
cat "$out"
printf '%s\n' "$handoff"
exit "$status"
