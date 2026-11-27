#!/usr/bin/env bash
# Existing Homebrew release gates consume the artifacts of the exact candidate SHA.
set -euo pipefail
commit="${1:?candidate commit required}"
output="${2:?new output directory required}"
run="${3:-}"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]]
if [ -z "$run" ]; then
  run="$(gh run list --repo "$GITHUB_REPOSITORY" --workflow session-guard-runtime.yml \
    --branch master --event workflow_dispatch --limit 100 --json databaseId,headSha,conclusion \
    --jq "map(select(.headSha == \"$commit\" and .conclusion == \"success\")) | first | .databaseId // empty")"
fi
if [ -z "$run" ]; then
  echo "No successful Session Guard runtime matrix for $commit" >&2
  exit 1
fi
[[ "$run" =~ ^[0-9]+$ ]]
gh run view "$run" --repo "$GITHUB_REPOSITORY" --json workflowName,headSha,headBranch,conclusion,event |
  jq -e --arg sha "$commit" '.workflowName == "Session Guard runtime qualification" and
    .headSha == $sha and .headBranch == "master" and .event == "workflow_dispatch" and .conclusion == "success"' >/dev/null
mkdir "$output"
gh run download "$run" --repo "$GITHUB_REPOSITORY" --pattern 'opencode-team-runtime-*' --dir "$output"
for target in darwin-arm64 darwin-x64 linux-arm64 linux-x64-baseline; do
  directory="$output/opencode-team-runtime-$target"
  jq -e --arg target "$target" 'keys == [$target]' "$directory/runtime-lock.json" >/dev/null
  mv "$directory/opencode-team-runtime-2.3.2-$target.tar.gz" "$output/"
done
jq -s add "$output"/opencode-team-runtime-*/runtime-lock.json > "$output/runtime-lock.json"
lock_sha="$(shasum -a 256 "$output/runtime-lock.json" | awk '{print $1}')"
jq -n --arg sha "$commit" --arg run "$run" --arg lock_sha "$lock_sha" \
  '{commit: $sha, matrix_run: $run, runtime_lock_sha256: $lock_sha}' > "$output/runtime-receipt.json"
