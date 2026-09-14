#!/bin/bash
set -euo pipefail

root=${OPENAI_TEAM_STATE_ROOT:-/tmp}
directory="$root/work-packets"
if [ ! -d "$directory" ] || ! compgen -G "$directory"/'[a-f0-9]'*.json >/dev/null; then
  printf '%s\n' "No completed work packets with token data have been recorded yet."
  exit 0
fi

jq -s -r '
  [ .[] | select(.completed_at != null) |
    select((.codex_input_tokens|type) == "number" or (.opencode_input_tokens|type) == "number") |
    . + {
      uncached_input_tokens: ((.codex_input_tokens // 0) + (.opencode_input_tokens // 0)),
      cached_input_tokens: ((.codex_cached_input_tokens // 0) + (.opencode_cached_input_tokens // 0)),
      cache_write_input_tokens: ((.codex_cache_write_input_tokens // 0) + (.opencode_cache_write_input_tokens // 0)),
      output_tokens: ((.codex_output_tokens // 0) + (.opencode_output_tokens // 0)),
      reasoning_tokens: ((.codex_reasoning_tokens // 0) + (.opencode_reasoning_tokens // 0)),
      total_tokens: ((.codex_total_tokens // 0) + (.opencode_total_tokens // 0)),
      exceeded: ((.codex_budget_status == "exceeded") or (.opencode_budget_status == "exceeded"))
    }
  ] | if length == 0 then "No completed work packets with token data have been recorded yet."
      else
        ("agent\tclassification\toutcome\tcount\texceeded_count\tavg_combined_uncached_input_tokens\tp50_combined_uncached_input_tokens\tp95_combined_uncached_input_tokens\tcached_input_tokens\tinput_tokens\toutput_tokens\treasoning_tokens\ttotal_tokens\tcache_ratio_pct"),
        (sort_by(.agent // "", .classification // "", .outcome // "") | group_by([(.agent // ""), (.classification // ""), (.outcome // "")])[] |
          sort_by(.uncached_input_tokens) as $items | ($items|length) as $n |
          ($items|map(.uncached_input_tokens)|add) as $input | ($items|map(.cached_input_tokens)|add) as $cached |
          [ $items[0].agent // "", $items[0].classification // "", $items[0].outcome // "", $n,
            ($items|map(select(.exceeded))|length), ($input / $n),
            $items[($n * .50 | ceil | tonumber) - 1].uncached_input_tokens,
            $items[($n * .95 | ceil | tonumber) - 1].uncached_input_tokens,
            $cached, $input, ($items|map(.output_tokens)|add), ($items|map(.reasoning_tokens)|add), ($items|map(.total_tokens)|add),
            (if $input + $cached > 0 then ($cached / ($input + $cached) * 100) else 0 end) ] | @tsv)
      end
' "$directory"/[a-f0-9]*.json
