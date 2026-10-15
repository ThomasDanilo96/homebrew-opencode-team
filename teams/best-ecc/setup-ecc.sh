#!/usr/bin/env bash
set -euo pipefail

source_root="${1:?usage: setup-ecc.sh <best-ecc-data-root>}"
commit="$(<"$(dirname "$0")/ecc.lock")"
target="$source_root/ecc"
required_assets=(
  .opencode/plugins/ecc-hooks.ts
  .opencode/tools/changed-files.ts
  .opencode/prompts/agents/tdd-guide.txt
  .opencode/prompts/agents/code-reviewer.txt
  scripts/hooks/skill-run-tracker.js
  scripts/lib/resolve-ecc-root.js
  skills/tdd-workflow/SKILL.md
  skills/verification-loop/SKILL.md
  skills/security-review/SKILL.md
  skills/agent-harness-construction/SKILL.md
  skills/coding-standards/SKILL.md
  skills/backend-patterns/SKILL.md
  skills/frontend-patterns/SKILL.md
  LICENSE
)

has_required_assets() {
  local asset
  for asset in "${required_assets[@]}"; do
    [ -f "$target/$asset" ] || return 1
  done
}

configure_sparse_checkout() {
  local repository="$1"
  git -C "$repository" sparse-checkout set --skip-checks \
    .opencode/plugins \
    .opencode/tools \
    .opencode/prompts/agents \
    scripts/hooks \
    scripts/lib \
    skills/coding-standards \
    skills/tdd-workflow \
    skills/verification-loop \
    skills/security-review \
    skills/agent-harness-construction \
    skills/backend-patterns \
    skills/frontend-patterns \
    package.json LICENSE
}

[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { printf 'Invalid ECC commit pin\n' >&2; exit 1; }
mkdir -p "$source_root"
chmod 700 "$source_root"

if [ -e "$target" ]; then
  if [ -d "$target/.git" ] && [ "$(git -C "$target" remote get-url origin 2>/dev/null || true)" = "https://github.com/affaan-m/ECC.git" ]; then
    actual="$(git -C "$target" rev-parse HEAD 2>/dev/null || true)"
    if [ "$actual" = "$commit" ] && has_required_assets; then
      printf 'ECC source already installed at pinned commit %s\n' "$commit"
      exit 0
    fi
    [ -z "$(git -C "$target" status --porcelain 2>/dev/null || true)" ] || {
      printf 'Refusing to update locally modified ECC source: %s\n' "$target" >&2
      exit 1
    }
    git -C "$target" fetch --depth 1 origin "$commit"
    configure_sparse_checkout "$target"
    git -C "$target" checkout --detach "$commit"
    has_required_assets || { printf 'Updated ECC checkout is missing required assets\n' >&2; exit 1; }
    printf 'Updated ECC source to pinned commit %s\n' "$commit"
    exit 0
  fi
  printf 'Refusing to replace an unexpected ECC source path: %s\n' "$target" >&2
  exit 1
fi

checkout="$(mktemp -d "$source_root/.ecc-checkout.XXXXXX")"
trap 'rm -rf "$checkout"' EXIT
git clone --filter=blob:none --no-checkout --depth 1 --sparse https://github.com/affaan-m/ECC.git "$checkout"
configure_sparse_checkout "$checkout"
git -C "$checkout" fetch --depth 1 origin "$commit"
git -C "$checkout" checkout --detach "$commit"

for required in "${required_assets[@]}"; do
  [ -f "$checkout/$required" ] || { printf 'Pinned ECC checkout is missing %s\n' "$required" >&2; exit 1; }
done

mv "$checkout" "$target"
trap - EXIT
printf 'Installed ECC source %s at %s\n' "$commit" "$target"
