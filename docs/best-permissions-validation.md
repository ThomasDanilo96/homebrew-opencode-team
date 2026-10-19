# BEST permissions validation — 2026-10-19

Status: locally validated, **not released**. Installed package remains 0.2.0;
the candidate configuration was applied with the source launcher `setup`.

## Cause and change

The published generator overrides the native base policy with `shell:* → ask`
and `external_directory:* → ask`. Environment-prefixed Django commands therefore
ask too; there is no special MySQL permission action. PR #1 changes these defaults
only for BEST. Additional changes replace BEST's remaining `.env` read prompts
with deny (except `.env.example`) and permit external reads for read-only agents.
FREE's generated permissions remain unchanged.

Plan, Explore and Reviewer retain deny-by-default, with no shell, edit, Code Mode,
delegation or mutating Serena permission. Build/General retain native permissions
with the shared BEST overrides. Models, provider policy, authentication and paths
are unchanged. Broad shell access is host authority, **not a sandbox**; deny rules
on reads do not prevent indirect access through shell, scripts or SSH.

## Evidence

- Recoverable checkpoint: `checkpoint/best-permissions-20261019` at `91efd38`.
  Original tree was clean; PR #1 is open against master, initially at `9126af5`.
- RED: generated-JSON regression test failed with exit 1 because secret-read deny
  rules were missing. Checkpoint commit: `a096527`.
- GREEN: generated-JSON and native evaluator focused tests passed, exit 0.
- Native OpenCode **2.0.32** permission API: tested full Django reproducer as a
  resource only, generic/env-prefixed shell, management commands, installs,
  Git status/fetch/push, SSH/SCP/SFTP/rsync, external directories, edits, skills,
  Serena and read-only denials. BEST allow / FREE ask as expected; exit 0.
  No command in this resource matrix was executed, including MySQL.
- API limitation: the standalone API host registers no CLI agents. Tests explicitly
  supply the documented base plus generated rules as session permissions. This is
  native evaluator coverage, not a claim of shell-scanner or agent-registry coverage.
- `node --test tests/*.test.mjs`: exit 0; 26 passed, 1 optional native test skipped.
  The optional native test was separately run with
  `OPENCODE_TEAM_NATIVE_TEST_BIN=/opt/homebrew/bin/opencode`; exit 0, no skips.
- `node --test --experimental-test-coverage tests/*.test.mjs`: exit 0;
  `shared/profiles.mjs` 100% lines, 88.19% branches, 97.83% functions.
- `bash tests/setup-smoke.sh`: exit 0 (mock runtime).
- `bash tests/homebrew-workflow.test.sh`: exit 0 (local workflow contract tests).
- Ruby formula/staging syntax, Bash/Zsh syntax, Node syntax and `git diff --check`:
  exit 0. No separate application build or static type checker is configured.
- Source `setup` and `doctor`: exit 0; Serena 1.7.0, pinned ECC verified.
  Configuration backup:
  `2026-10-19T14-51-23.597Z-ab3860d4-58f5-49a2-bc25-8cba0908edf1`.
- Actual installed `opencode-team best run --format json`, **without `--auto`**,
  in a disposable directory: exit 0. Shell `FLAG=yes python3 ...` printed `yes`;
  General created `add.py` and `test_add.py`, ran 4 failing tests (exit 1), fixed
  addition and ran 4 passing tests (exit 0). Reviewer read only the two files,
  without shell or modifications. Parent session:
  `ses_eab5a730affeuywtlvRqBLSRTe`; no `Permission required` in its JSON events.
  The launcher is still the installed 0.2.0 launcher reading candidate configuration;
  this does not prove a new Homebrew package has been distributed.
- Actual `opencode-team free run`: exit 0, returned `FREE_OK`, no tools or fallback.

## Distribution blockers

`gh` has no authenticated GitHub host (`gh pr view` exit 4). No login or credential
export was attempted. Remote CI, PR merge and release creation are not certified.
Normal non-interactive Git push did succeed: PR #1's branch now includes the
implementation at `5010a5e`. Git transport access does not authenticate `gh` API
operations; no credential extraction was used to bridge the two.
`brew test opencode-team` exits 1 because Homebrew refuses the untrusted
`thomasdanilo96/opencode-team` tap; runtime formula inspection also refused the
untrusted `anomalyco/tap`. Trust was not relaxed to bypass these gates.

Do not publish 0.2.1 or update the stable formula/checksum until required remote
and Homebrew gates pass. Tag v0.2.0 and the Premium configuration were not changed.
