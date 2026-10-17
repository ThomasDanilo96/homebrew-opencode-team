#!/usr/bin/env bash
set -euo pipefail

workflow="${1:-.github/workflows/homebrew-install.yml}"
expected_version="$(tr -d '[:space:]' < VERSION)"

[[ "$expected_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
grep -Fq 'expected_version="$(tr -d '\''[:space:]'\'' < VERSION)"' "$workflow"
grep -Fq 'test "$(opencode-team version)" = "OpenCode Team $expected_version"' "$workflow"
grep -Fq 'if [ "$team" = best ]; then launch_team=best-opencode; fi' "$workflow"
grep -Fq 'OPENCODE_TEAM_PACKAGE_ROOT="$package_root"' "$workflow"
grep -Fq '"$ROOT/bin/opencode-team" best' "${workflow%/*}/../../tests/setup-smoke.sh"
if grep -En '0\.1\.17|v0\.1\.17' "$workflow"; then
  echo "workflow contains a stale release version" >&2
  exit 1
fi
if grep -En 'shasum -a 256 .*oh-my-openagent.*=' "$workflow"; then
  echo "workflow contains a frozen OMO bundle hash" >&2
  exit 1
fi
grep -Fq 'teams/best/verify-omo.sh' "$workflow"
grep -Fq 'teams/go/verify-omo.sh' "$workflow"
grep -Fq 'release_state' "$workflow"
grep -Fq 'needs: source-validation' "$workflow"
grep -Fq 'expected_url="https://github.com/ThomasDanilo96/homebrew-opencode-team/archive/refs/tags/v${expected_version}.tar.gz"' "$workflow"
grep -Fq "formulae[0].urls.stable.url" "$workflow"
grep -Fq "formulae[0].urls.stable.checksum" "$workflow"
grep -Fq 'formula_url" != "$expected_url"' "$workflow"
grep -Fq 'brew fetch --force ThomasDanilo96/opencode-team/opencode-team' "$workflow"
grep -Fq 'for dependency in git jq node@22 ripgrep terminal-notifier tmux uv opencode' "$workflow"
grep -Fq 'brew fetch --force-bottle "$dependency"' "$workflow"
grep -Fq 'Gem::Version.new("1.18.30")' "$workflow"
grep -Fq 'Verify launcher in installed release archive' "$workflow"
grep -Fq 'node --test "$(brew --prefix opencode-team)/libexec/tests/opencode-team-launcher-regression.test.mjs"' "$workflow"
grep -Fq 'brew test ThomasDanilo96/opencode-team/opencode-team' "$workflow"
grep -Fq 'brew audit --strict --formula ThomasDanilo96/opencode-team/opencode-team' "$workflow"
grep -Fq 'brew update' "$workflow"
grep -Fq 'timeout-minutes: 60' "$workflow"
grep -Fq 'brew install --verbose ThomasDanilo96/opencode-team/opencode-team' "$workflow"
grep -Fq 'runs-on: macos-26' "$workflow"
grep -Fq 'opencode models openai' "$workflow"
grep -Fq 'opencode-team deep-audit-doctor' "$workflow"
grep -Fq 'Runtime tool state[[:space:]]+VERIFIED' "$workflow"
grep -Fq 'tests/deep-audit-sandbox.test.sh' "$workflow"
grep -Fq 'tests/deep-audit-scanner.test.mjs' "$workflow"
grep -Fq 'tests/deep-audit-runtime-smoke.sh' "$workflow"
grep -Fq 'for team in best best-ecc deep-audit go openai daily' "$workflow"
grep -Fq 'prepublication-staging:' "$workflow"
grep -Fq "if: github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/heads/prerelease/') && needs.release_state.outputs.published == 'false'" "$workflow"
grep -Fq 'candidate_sha="$(git rev-parse HEAD)"' "$workflow"
grep -Fq 'test "$candidate_sha" = "$GITHUB_SHA"' "$workflow"
grep -Fq 'git archive --format=tar.gz --prefix="opencode-team-$version/" "$candidate_sha"' "$workflow"
grep -Fq 'brew tap-new --no-git opencode-team/staging' "$workflow"
grep -Fq '.github/scripts/render-staging-formula.rb' "$workflow"
grep -Fq 'source.gsub!(/^  disable! .*\n/, "")' "${workflow%/*}/../scripts/render-staging-formula.rb"
grep -Fq 'brew test --verbose --force "$formula"' "$workflow"
grep -Fq 'test "$(command -v opencode-team)" = "$(brew --prefix)/bin/opencode-team"' "$workflow"
grep -Fq 'gitleaks dir "$package_root"' "$workflow"
grep -Fq 'official_archive_sha256' "$workflow"
grep -Fq 'official-archive-validation:' "$workflow"
grep -Fq 'actual_sha256="$(shasum -a 256 "$archive"' "$workflow"
grep -Fq 'brew test --verbose --force opencode-team/staging/opencode-team-official' "$workflow"
grep -Fq 'publish-stable-release:' "$workflow"
grep -Fq "needs.clean-install.result == 'success'" "$workflow"
grep -Fq 'gh release create "$tag"' "$workflow"
python3 - "$workflow" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text()
prepublication = text.split("  clean-install:", 1)[0]
if "brew tap ThomasDanilo96/opencode-team" in prepublication:
    raise SystemExit("prepublication/official archive validation must not tap the stable formula")

staging = text.split("  prepublication-staging:\n", 1)[1].split("  official-archive-validation:\n", 1)[0]
staging_gate = "if: github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/heads/prerelease/') && needs.release_state.outputs.published == 'false'"
if staging_gate not in staging or staging.count("    if:") != 1:
    raise SystemExit("Phase A must require dispatch of a prerelease branch with no published vVERSION tag")
if "- name: Checkout candidate source\n        uses: actions/checkout@v4\n        with:\n          ref: ${{ github.sha }}" not in staging:
    raise SystemExit("Phase A must check out the selected ref SHA")
if 'candidate_sha="$(git rev-parse HEAD)"' not in staging or 'test "$candidate_sha" = "$GITHUB_SHA"' not in staging:
    raise SystemExit("Phase A must bind the archive to the selected dispatch commit")
if 'git archive --format=tar.gz --prefix="opencode-team-$version/" "$candidate_sha"' not in staging:
    raise SystemExit("Phase A must archive the selected ref SHA")
if "brew tap-new --no-git opencode-team/staging" not in staging or 'formula="$(brew --repo opencode-team/staging)/Formula/opencode-team-staging.rb"' not in staging:
    raise SystemExit("Phase A formula must stay in the temporary no-git tap")

official = text.split("  official-archive-validation:\n", 1)[1].split("  clean-install:\n", 1)[0]
if "github.event_name == 'push' && github.ref_type == 'tag'" not in official or 'archive_url="https://github.com/ThomasDanilo96/homebrew-opencode-team/archive/refs/tags/v$version.tar.gz"' not in official:
    raise SystemExit("tag pushes must still validate the official vVERSION archive")
if "gh run list" not in official or "prepublication-staging" not in official or 'test "$tag_commit" = "$GITHUB_SHA"' not in official:
    raise SystemExit("Phase B must prove Phase A succeeded for the exact tagged candidate commit")

release = text.split("  publish-stable-release:\n", 1)[1]
if "needs: [source-validation, release_state, clean-install]" not in release or "if: github.event_name == 'workflow_dispatch' && inputs.publish_stable_release && needs.release_state.outputs.published == 'true' && needs.clean-install.result == 'success'" not in release:
    raise SystemExit("stable Release creation must require explicit publication after green stable clean-install")
PY
if grep -Fq 'opencode-team best-ecc-setup' "$workflow" || grep -Fq 'opencode-team deep-audit-setup' "$workflow"; then
  echo "clean-install workflow repeats setup work already performed by setup" >&2
  exit 1
fi
grep -Fq 'git ls-remote origin "refs/tags/$tag"' "$workflow"
grep -Fq 'if ! tag_result=' "$workflow"
grep -Fq 'resolved_ref="$(printf '\''%s\\n'\'' "$tag_result" | awk '\''NR == 1 { print $2 }'\'')"' "$workflow"
if grep -Fq 'git ls-remote --exit-code' "$workflow"; then
  echo "workflow cannot distinguish a missing tag from a failed remote lookup" >&2
  exit 1
fi
if command -v actionlint >/dev/null 2>&1; then
  actionlint "$workflow"
fi
