#!/usr/bin/env bash
set -euo pipefail
ROOT="${OPENCODE_TEAM_PACKAGE_ROOT:-$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
bash -n "$ROOT/bin/opencode-team"
node --check "$ROOT/shared/profiles.mjs"
node --test "$ROOT/tests/native-profiles.test.mjs"
printf '%s\n' 'PACKAGING CONFIG SMOKE PASS (mock native runtime; no network/auth provisioning)'
