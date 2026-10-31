#!/usr/bin/env bash
set -euo pipefail
# Use native Homebrew's Cellar path, not a tap-qualified formula name as a path.
verify_receipt() {
  local formula="$1" cellar_dir r
  cellar_dir="$("$brew" --cellar "$formula")" || return 1
  for r in "$cellar_dir"/*/INSTALL_RECEIPT.json; do
    [ ! -f "$r" ] || return 0
  done
  return 1
}
[[ "${BASH_SOURCE[0]}" != "$0" ]] && return 0
: "${OPENCODE_TEAM_STAGING_ROOT:?Use tests/guardrail/runner.sh homebrew}"
ROOT="$(cd -P "$(dirname "$0")/.." && pwd)"
[[ "$ROOT" = "$OPENCODE_TEAM_STAGING_ROOT" ]] || exit 70
work="$(mktemp -d "$TMPDIR/homebrew-stage.XXXXXXXX")"
prefix="$work/prefix"
mkdir -p "$prefix/bin" "$prefix/Library/Taps/homebrew" \
  "$prefix/Library/Taps/opencode-team/homebrew-staging/Formula" \
  "$work/cache" "$work/logs" "$work/build-temp"
# A real copy is essential: a symlinked bin/brew resolves the original Cellar.
cp /opt/homebrew/bin/brew "$prefix/bin/brew"
ln -s /opt/homebrew/Library/Homebrew "$prefix/Library/Homebrew"
ln -s /opt/homebrew/Library/Taps/homebrew/homebrew-core \
  "$prefix/Library/Taps/homebrew/homebrew-core"
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_INSTALL_FROM_API=1
export HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ENV_HINTS=1
export HOMEBREW_CURL_RETRIES=0
export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=Never SSH_ASKPASS_REQUIRE=never
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.interactive GIT_CONFIG_VALUE_0=false
export GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o NumberOfPasswordPrompts=0 -o ConnectTimeout=15'
export HOMEBREW_CACHE="$work/cache" HOMEBREW_LOGS="$work/logs" HOMEBREW_TEMP="$work/build-temp"
# Homebrew's supported opt-in reuses the *existing* kernel sandbox. The outer
# guardrail remains intact; there is no unguarded retry or network exemption.
export HOMEBREW_AVOID_NESTED_SANDBOXING=1
USER="$(/usr/bin/id -un)"; export USER
brew="$prefix/bin/brew"
blocked() {
  echo "HOMEBREW_RESULT=BLOCKED phase=$1; no real-prefix retry"
  exit 3
}
actual="$("$brew" --prefix)" || blocked prefix
[[ "$actual" = "$prefix" ]] || blocked prefix-mismatch
actual="$("$brew" --cellar)" || blocked cellar
[[ "$actual" = "$prefix/Cellar" ]] || blocked cellar-mismatch
echo "HOMEBREW_ISOLATED_PREFIX=$actual"
"$brew" --version || blocked version
tar -czf "$work/candidate.tar.gz" -C "$ROOT" bin shared tests Formula completions VERSION .github
sha="$(/usr/bin/shasum -a 256 "$work/candidate.tar.gz" | /usr/bin/awk '{print $1}')"
ruby "$ROOT/.github/scripts/render-staging-formula.rb" "$ROOT/Formula/opencode-team.rb" \
  "$prefix/Library/Taps/opencode-team/homebrew-staging/Formula/opencode-team-candidate.rb" \
  OpencodeTeamCandidate "$(tr -d '[:space:]' < "$ROOT/VERSION")" "file://$work/candidate.tar.gz" "$sha"
formula=opencode-team/staging/opencode-team-candidate

# Readonly reuse: the sandbox denies network and the 105-char temp prefix
# defeats bottle relocation (max 13 chars), so deps cannot be fetched
# (ghcr.io unreachable). Symlink each real-cellar keg (valid receipt
# required) into the isolated prefix so brew sees it as installed.
seed_dep() {
  local name="$1"
  [[ -e "/opt/homebrew/opt/$name" ]] || return 1
  local rc ver
  rc="$(/usr/bin/python3 -I -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "/opt/homebrew/opt/$name")" || return 1
  [[ -f "$rc/INSTALL_RECEIPT.json" ]] || return 1
  ver="$(basename "$rc")"
  mkdir -p "$prefix/Cellar/$name" "$prefix/opt"
  ln -sf "$rc" "$prefix/Cellar/$name/$ver"
  ln -sf "../Cellar/$name/$ver" "$prefix/opt/$name"
}

# Resolve the authoritative dependency graph; an unavailable resolver blocks.
deps="git node@22 uv"
for root in git node@22 uv; do
  out="$("$brew" deps "$root")" || blocked deps
  deps="$deps $out"
done
seen=""; uniq=""
for d in $deps; do
  case " $seen " in *" $d "*) ;; *) seen="$seen $d"; uniq="$uniq $d"; ;; esac
done
deps="$uniq"
[[ -n "$deps" ]] || blocked deps
for dep in $deps; do seed_dep "$dep" || blocked seed-dep; done

echo "HOMEBREW_INSTALL_START (dependencies are not ignored)"
"$brew" install --formula "$formula" || blocked install
verify_receipt "$formula" || blocked receipt
"$brew" test --force "$formula" || blocked test
"$prefix/bin/opencode-team" version || blocked cli
cmp "$prefix/opt/opencode-team-candidate/libexec/shared/maintenance.py" "$ROOT/shared/maintenance.py" || blocked code-hash
"$brew" uninstall --formula "$formula" || blocked uninstall
[[ ! -e "$prefix/bin/opencode-team" ]] || blocked uninstall-link
echo "HOMEBREW_RESULT=PASS (isolated prefix only)"
