#!/usr/bin/env bash
set -euo pipefail

workflow="${1:-.github/workflows/homebrew-install.yml}"
expected_version="$(tr -d '[:space:]' < VERSION)"

[[ "$expected_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
grep -Fq 'expected_version="$(tr -d '\''[:space:]'\'' < VERSION)"' "$workflow"
grep -Fq 'test "$(opencode-team version)" = "OpenCode Team $expected_version"' "$workflow"
grep -Fq 'OPENCODE_TEAM_PACKAGE_ROOT="$package_root"' "$workflow"
grep -Fq 'PACKAGING CONFIG SMOKE PASS' "${workflow%/*}/../../tests/setup-smoke.sh"
grep -Fq 'DEEP_AUDIT_SANDBOX PASS' "${workflow%/*}/../../tests/deep-audit-sandbox.test.sh"
if grep -En '0\.1\.17|v0\.1\.17' "$workflow"; then
  echo "workflow contains a stale release version" >&2
  exit 1
fi
if grep -En 'shasum -a 256 .*oh-my-openagent.*=' "$workflow"; then
  echo "workflow contains a frozen OMO bundle hash" >&2
  exit 1
fi
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
grep -Fq 'node --test "$ROOT/tests/opencode-team-launcher-regression.test.mjs"' "${workflow%/*}/../../tests/setup-smoke.sh"
grep -Fq 'brew test ThomasDanilo96/opencode-team/opencode-team' "$workflow"
grep -Fq 'brew audit --strict --formula ThomasDanilo96/opencode-team/opencode-team' "$workflow"
grep -Fq 'brew update' "$workflow"
grep -Fq 'timeout-minutes: 60' "$workflow"
grep -Fq 'brew install --verbose ThomasDanilo96/opencode-team/opencode-team' "$workflow"
grep -Fq 'runs-on: macos-26' "$workflow"
grep -Fq 'tests/deep-audit-sandbox.test.sh' "$workflow"
grep -Fq 'tests/deep-audit-scanner.test.mjs' "$workflow"
grep -Fq 'tests/deep-audit-runtime-smoke.sh' "$workflow"
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
grep -Fq 'inputs.publish_stable_release' "$workflow"
grep -Fq 'No successful stable clean-install run found' "$workflow"
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
if "start-docker-desktop.sh" in staging or "brew install --cask docker" in staging or "deep-audit-runtime-smoke.sh" in staging:
    raise SystemExit("Phase A Homebrew package validation must not provision Docker or run Docker runtime tests")
if 'tests/deep-audit-sandbox.test.sh' not in Path("tests/setup-smoke.sh").read_text():
    raise SystemExit("Phase A must test the macOS Seatbelt policy from the installed candidate package")

official = text.split("  official-archive-validation:\n", 1)[1].split("  clean-install:\n", 1)[0]
if "github.event_name == 'push' && github.ref_type == 'tag'" not in official or 'archive_url="https://github.com/ThomasDanilo96/homebrew-opencode-team/archive/refs/tags/v$version.tar.gz"' not in official:
    raise SystemExit("tag pushes must still validate the official vVERSION archive")
if "start-docker-desktop.sh" in official or "brew install --cask docker" in official:
    raise SystemExit("official archive packaging validation must not provision Docker Desktop")
if "gh run list" not in official or "prepublication-staging" not in official or 'test "$tag_commit" = "$GITHUB_SHA"' not in official:
    raise SystemExit("Phase B must prove Phase A succeeded for the exact tagged candidate commit")

clean_install = text.split("  clean-install:\n", 1)[1].split("  publish-stable-release:\n", 1)[0]
if "start-docker-desktop.sh" in clean_install or "brew install --cask docker" in clean_install or "opencode-team setup" in clean_install or "deep-audit-runtime-smoke.sh" in clean_install:
    raise SystemExit("stable Homebrew clean-install must not repeat Docker/profile provisioning")
if 'tests/setup-smoke.sh' not in clean_install or 'gitleaks dir "$package_root"' not in clean_install:
    raise SystemExit("stable Homebrew clean-install must run packaged non-Docker smoke and Gitleaks")
if "inputs.publish_stable_release" not in clean_install:
    raise SystemExit("release publication dispatch must reuse, not repeat, the verified stable clean-install")

release = text.split("  publish-stable-release:\n", 1)[1]
if "needs: [source-validation, release_state]" not in release or "if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/master' && inputs.publish_stable_release && needs.release_state.outputs.published == 'true'" not in release:
    raise SystemExit("stable Release creation must require master dispatch and explicit publication")
if "Verify Phase B evidence for immutable tag SHA" not in release or 'git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}"' not in release:
    raise SystemExit("publication must resolve the immutable tag SHA before checking Phase B evidence")
if "gh run list" not in release or "--event push --branch \"$tag\"" not in release or 'select(.headSha == $sha and .conclusion == "success")' not in release or 'select(.name == "official-archive-validation")' not in release:
    raise SystemExit("publication must refuse missing, failed, or mismatched Phase B evidence")
if 'gh run list --repo "$GITHUB_REPOSITORY" --workflow \'Homebrew Install\' --event push --branch master' not in release or 'select(.name == "clean-install")' not in release or 'clean_job" != success' not in release:
    raise SystemExit("publication must reuse only a successful stable clean-install for the exact master formula commit")
if 'echo "tag_sha=$tag_sha" >>"$GITHUB_OUTPUT"' not in release or 'VERIFIED_TAG_SHA: ${{ steps.verify-phase-b.outputs.tag_sha }}' not in release or '"$current_tag_sha" != "$VERIFIED_TAG_SHA"' not in release:
    raise SystemExit("publication must recheck the immutable tag SHA immediately before Release creation")
if "      actions: read\n      contents: write" not in release:
    raise SystemExit("publication requires read-only Actions access and contents write access")
PY
if grep -Fq 'opencode-team best-ecc-setup' "$workflow" || grep -Fq 'opencode-team deep-audit-setup' "$workflow"; then
  echo "clean-install workflow repeats setup work already performed by setup" >&2
  exit 1
fi
grep -Fq 'git ls-remote origin "refs/tags/$tag"' "$workflow"
grep -Fq 'if ! tag_result=' "$workflow"
grep -Fq 'resolved_ref="$(printf '\''%s\n'\'' "$tag_result" | awk '\''NR == 1 { print $2 }'\'')"' "$workflow"
if grep -Fq 'git ls-remote --exit-code' "$workflow"; then
  echo "workflow cannot distinguish a missing tag from a failed remote lookup" >&2
  exit 1
fi
if command -v actionlint >/dev/null 2>&1; then
  actionlint "$workflow"
fi
