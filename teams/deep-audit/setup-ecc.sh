#!/usr/bin/env bash
set -euo pipefail

target="${1:?usage: setup-ecc.sh <deep-audit-ecc-root>}"
commit="$(<"$(dirname "$0")/../best-ecc/ecc.lock")"
source_root="$(dirname "$target")"
skills=(
  coding-standards backend-patterns security-review verification-loop production-audit
  django-patterns django-security django-verification django-tdd python-patterns python-testing
  mysql-patterns database-migrations api-design e2e-testing agent-architecture-audit
  workspace-surface-audit mcp-dependency-review
)

configure_sparse_checkout() {
  local repository="$1" skill
  local paths=(package.json LICENSE)
  for skill in "${skills[@]}"; do paths+=("skills/$skill"); done
  git -C "$repository" sparse-checkout set --skip-checks "${paths[@]}"
}

has_required_skills() {
  local skill
  for skill in "${skills[@]}"; do
    [ -f "$target/skills/$skill/SKILL.md" ] || return 1
  done
}

[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { printf 'Invalid pinned ECC commit\n' >&2; exit 1; }
mkdir -p "$source_root"
chmod 700 "$source_root"

if [ -e "$target" ]; then
  if [ -d "$target/.git" ] && [ "$(git -C "$target" remote get-url origin 2>/dev/null || true)" = "https://github.com/affaan-m/ECC.git" ]; then
    actual="$(git -C "$target" rev-parse HEAD 2>/dev/null || true)"
    if [ "$actual" = "$commit" ] && has_required_skills; then
      printf 'Deep Audit ECC skills already installed at %s\n' "$commit"
      exit 0
    fi
    [ -z "$(git -C "$target" status --porcelain 2>/dev/null || true)" ] || { printf 'Refusing to update locally modified Deep Audit ECC source\n' >&2; exit 1; }
    git -C "$target" fetch --depth 1 origin "$commit"
    configure_sparse_checkout "$target"
    git -C "$target" checkout --detach "$commit"
    has_required_skills || { printf 'Pinned ECC checkout is missing a required audit skill\n' >&2; exit 1; }
    printf 'Updated Deep Audit ECC skills to %s\n' "$commit"
    exit 0
  fi
  printf 'Refusing to replace unexpected Deep Audit ECC source: %s\n' "$target" >&2
  exit 1
fi

checkout="$(mktemp -d "$source_root/.deep-audit-ecc.XXXXXX")"
trap 'rm -rf "$checkout"' EXIT
git clone --filter=blob:none --no-checkout --depth 1 --sparse https://github.com/affaan-m/ECC.git "$checkout"
configure_sparse_checkout "$checkout"
git -C "$checkout" fetch --depth 1 origin "$commit"
git -C "$checkout" checkout --detach "$commit"
target_parent="$(dirname "$target")"
mkdir -p "$target_parent"
mv "$checkout" "$target"
trap - EXIT
has_required_skills || { printf 'Pinned ECC checkout is missing a required audit skill\n' >&2; exit 1; }
