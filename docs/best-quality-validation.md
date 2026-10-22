# BEST quality + Playwright validation (2026-10-22)

## Status

Local candidate on `feat/best-code-quality-playwright`; no new release published.
Homebrew remains 0.3.1. VERSION/formula/tags are unchanged. `gh workflow list`
returned exit **4** (no GitHub CLI authentication). Required remote release gates
could not be dispatched; no login, credential workaround, tag or stable upgrade
was attempted. The repository's documented release pipeline remains authoritative.

`bin/opencode-team setup` (exit 0) activated the candidate locally, **from source**,
not from an upgraded Homebrew keg. Backup:
`2026-10-22T15-11-49.142Z-741a4e43-4d0a-40eb-8d9a-cf7aecbe30fe`.
`bin/opencode-team doctor` passed (exit 0): OpenCode 2.1.0, Serena 1.7.0,
ECC b92f181b3b748d1abbc2afd94af6aa7d8c8fca29. One initial 30s doctor attempt
timed out; the 120s retry completed. Doctor is not a connectivity/auth test.
Use `bin/opencode-team best` from this branch for the candidate launcher and its
private scanner PATH. The installed 0.3.1 launcher can read the updated MCP/profile
instructions, but does **not** include the new PATH handling until a release is
installed. Its private scanners otherwise require their explicit absolute paths.

## Browser evidence

`npm view @playwright/mcp version dist.integrity repository --json` (exit 0):
Microsoft repository, version **0.0.83**, integrity
`sha512-oNcl+Ae2/IAjhfPeP46BfIkSakfmprY+aOtkv5MjrQ4lPav4/yNtPhL0iq8SlIM90oApWgBDUxaNKvktazUKOg==`.
Its Playwright/playwright-core dependencies are both pinned to
`1.64.0-alpha-1790635538000` (official package dependency, not a stable-runtime claim).
`npx --yes @playwright/mcp@0.0.83 --help` passed (exit 0).
`npm exec --yes --package=@playwright/mcp@0.0.83 -- playwright install chromium`
(exit 0) installed official Chromium/headless-shell revision **1247** in Playwright's
cache, without changing personal browsers.

Temporary fixtures live under
`/private/var/folders/fs/7py3y1294056jtqn3vhvq3l80000gn/T/opencode/`:

- `node browser-fixture.mjs` (from that directory, exit 0) initialized the real
  stdio MCP, listed **25 tools**, navigated to a loopback HTTP server and clicked
  `role=button[name="Increment"]`. Expected count 1, actual 2 reproduced the bug.
  A one-expression correction (2 → 1) passed the same interaction/content check.
  `browser_find` read Counter semantically. A missing button returned
  `isError=true`; a subsequent call succeeded. Finally `browser_close` completed,
  MCP exited 0 and the HTTP server closed. No screenshot or credentials used.
- After setup, OpenCode's actual native Code Mode catalog exposed the 25
  `tools.playwright.*` tools. `node native-browser-fixture.mjs` hosted a second
  temporary loopback app at 127.0.0.1:18743. Native `browser_navigate`,
  `browser_click` and `browser_evaluate` reproduced `{expected:"1",actual:"2"}`;
  enabling the one-expression fix and repeating returned actual `"1"`.
  A missing-element call returned an error, cleanup used `browser_close`;
  a subsequent close confirmed **No open tabs**. MCP calls have tool results,
  not shell exit codes. This is real native integration, not just a config mock.
- `ps -axo pid,ppid,command` filtered for the new Chromium revision and MCP
  showed no remaining fixture processes after the standalone fixture.
- Serena `get_symbols_overview(shared/profiles.mjs)` succeeded after setup in
  the native session. `best api get /api/mcp` alone returned an empty lazy catalog;
  this was not treated as proof of connectivity.

## Regression evidence

- New BEST-only pinned/isolated MCP assertion: RED exit 1 (server absent), then
  GREEN exit 0. BEST-only scanner PATH assertion: RED exit 1, then GREEN exit 0.
- `node --test tests/*.test.mjs`: 34 passed, 2 optional integrations skipped,
  exit 0 (before the later PATH addition).
- `bash tests/setup-smoke.sh`: 26 passed, 1 optional native integration skipped,
  exit 0 (before PATH addition; mock provisioning, not real Homebrew installation).
- `bash tests/homebrew-workflow.test.sh`: seven release scenarios passed, exit 0.
- `OPENCODE_TEAM_NATIVE_TEST_BIN=/opt/homebrew/bin/opencode node --test
  --test-name-pattern='native V2 resolves' tests/native-profiles.test.mjs`:
  real V2 permission resolution passed, exit 0 (132.9s); no shell resources executed.
- After PATH addition: `node --test --test-name-pattern='only best/free public|BEST
  keeps an OpenAI' tests/native-profiles.test.mjs`: 2 passed, exit 0. Initial 30s
  attempt timed out; 120s retry passed.
- `node --check shared/profiles.mjs`, `git diff --check`: exit 0.
- Final `node --test --test-concurrency=1 tests/*.test.mjs`: **34 passed,
  2 optional integrations skipped, exit 0** (173.8s), including all new assertions.
  The preceding concurrent full run had 33 pass / 1 fail / 2 skip: SIGINT fixture
  missed its existing two-second startup deadline. One isolated retry also
  failed, the next passed. No test timeout/assertion was changed or suppressed.
- Existing Homebrew installation: `opencode-team version` reports **0.3.1**;
  `opencode-team doctor` passed, exit 0. This does not test candidate launcher code
  from an installed keg. `ruby -c Formula/opencode-team.rb`: Syntax OK, exit 0.
- `brew test opencode-team`: **exit 1**, reports missing test dependencies
  brotli/node@22/uv. Attempted `HOMEBREW_NO_AUTO_UPDATE=1 brew install brotli
  node@22 uv` exceeded 180s and received SIGTERM. Homebrew resolved this to a
  broader dependent-upgrade plan; no further install was attempted. Observed
  installed change: brotli **1.2.1** added alongside 1.2.0; ca-certificates pour
  began but no new version appears in `brew list --versions`. node@22 remains
  22.23.3_3, uv remains 0.13.3 (older versions also retained). Downloads included
  unrelated dependent bottles, but output does not show their installation.
  This host-side expansion was unintended; it is not claimed as a successful
  Homebrew verification or part of BEST configuration.

FREE config/instructions and classic config/global AGENTS SHA-256 hashes were
identical before/after source setup. No models, accounts, sessions or backups
were migrated. Reviewer remains the existing read-only role (no new system).
Scanner fixture commands, findings and limitations are recorded separately in
[best-quality-scanners.md](best-quality-scanners.md).

## Token/cost boundary

No comparable before/after model-token measurement is available. No percentage
savings or monetary claim is made. Code Mode and explicit semantic lookups avoid
automatic full snapshots, but additional instructions/tools are not free context.
Scanners cannot establish that every abstraction is necessary or find every bug.

## Review / delivery limits

The existing independent read-only Reviewer inspected the changed files and
reported PASS with no concrete minimalism/security findings. It did not rerun
tests or independently reproduce browser evidence. No custom review layer added.
No build/typecheck script exists for this plain .mjs launcher; syntax, behavioral
Node tests and Ruby syntax were used instead. Coverage was not measured.

Self-evaluation (1–5): accuracy 4 (real evidence, no remote release proof),
completeness 3 (release/installed-candidate gate blocked), clarity 4 (separate local
and stable status), actionability 3 (GitHub access and Homebrew health needed),
conciseness 4 (small implementation; detailed evidence retained here). Average
3.6. Highest-impact follow-up: restore authorized GitHub CLI access and complete
the official release pipeline; resolve Homebrew dependencies without broad
dependent upgrades. These limits likely matter more to the user than the score.
