# OpenCode Team 0.3.8 — candidate readiness

## Decision: NO-GO for publication and local upgrade

Candidate source version: **0.3.8**, not published or installed. Stable release:
[v0.3.7](https://github.com/ThomasDanilo96/homebrew-opencode-team/releases/tag/v0.3.7).
Baseline branch `master`, HEAD `f857b0f9cb179726c23932ec2708d4a6fab35b0c`;
the remote master matched this commit during preflight. The remote has no
v0.3.8 tag. Existing local governor/Hybrid changes were preserved.

Publication, tags, push, commits and actual local upgrade are not performed:
the mandate conditions them on critical qualification, which remains incomplete.
No current gate is bypassed to produce a release.

## Corrections applied

- Fresh generated BEST loads its packaged governor; FREE remains governor-free.
  The personal configuration is not regenerated or changed.
- `quota install` migrates a verified previous governor package path instead of
  adding a second plugin. Custom options, agent models, FREE and exact native
  rollback backup are preserved; migration is tested only in disposable fixtures.
- An uninitialized quota state is reported as monitor, matching runtime behavior.
- `activate` now requires current process/location coverage, not merely the old
  simulated `hookVerified` flag. Discovery uses bounded PID/start-time/open-DB
  metadata, no server passwords, command arguments or database contents.
  Missing/new/reused PIDs, retired/test receipts, missing locations and callbacks
  older than 15 minutes fail closed. Billing is rechecked under the state lock;
  a reload retiring the admitted receipt also blocks activation.
- Corrected native V2 `metadata.accountID` in account fingerprints, quota
  headers and transport checks. The previous `accountId` spelling did not bind
  the real account. Browser and supported headless OAuth use the official V2
  schema. Mismatched/missing selectors and API-key channels remain rejected.
  Old unbound account history is not relabelled under the corrected identity.
- Stable/staging packaging ships the governor and complete guarded test assets.
  Formula tests use the isolated smoke runner, not unguarded setup-smoke.
  The staging renderer no longer corrupts multiline install arguments or leaves
  `best-quota-native.test.mjs` in the wrong directory.
- Candidate VERSION advanced to 0.3.8. The stable URL/SHA remain **0.3.7** until
  a qualified 0.3.8 official archive exists. No placeholder SHA was inserted.
- Repaired the existing code-rollback fixture: explicitly selected code archives
  are staged inside the unchanged kernel boundary, and old/new versions come
  from the verified code rather than hardcoded 0.3.6/0.3.7 assumptions.

The account correction follows the installed tag's official implementation:
https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/plugin/provider/openai.ts

## Verification actually executed

| Check | Result |
| --- | --- |
| Governor engine/runtime/sources/CLI/native, Node 22.23.4 | **84/84 PASS**, no skip, exit 0 |
| Complete macOS kernel-sandbox guardrail regression | **PASS**, exit 0 |
| Native profile source fixtures | 50 PASS, 1 optional native-permission skip |
| Routing | 20/20 PASS |
| Hybrid evidence contracts | 5 PASS, 1 real-export evidence skip |
| Packaging/Ruby DSL and installed fixture smoke | 4/4 PASS |
| Disk cleanup fixtures | 3/3 PASS |
| Python maintenance / evidence / benchmark unit suites | 60/60, 15/15, 2/2 PASS |
| Isolation negative controls | 13/13 PASS |
| Installed source smoke repeated by guardrail | PASS; uses mocked native runtime, not account certification |
| Shell release-state scenarios and receipt behavior | PASS |
| Ruby/bash/zsh/Node syntax and actionlint | PASS |
| Code rollback 0.3.8 → 0.3.7 → 0.3.8 and maintenance-link recovery | PASS in disposable, kernel-sandboxed fixtures; launchctl mocked |
| Real isolated `brew install` | **BLOCKED**, exit 3; sandbox refusal described below |

The source baseline initially failed packaging. The new fresh-BEST, migration,
account-isolation and global-gate regressions were verified RED before GREEN.
The governor coverage command reports engine 98.78%, runtime 85.53%, sources
94.52% and CLI 97.30% line coverage. Overall 84.33% includes test files and the
partially exercised dispatcher; it is not whole-product coverage.
Neither skip is counted as live runtime PASS. Native tests use loopback scripted
responses and synthetic quota/authentication bindings; no model inference is
initiated for qualification.

Commands and full local logs/manifests are retained privately in
`.local-release-evidence/release-0.3.8/`. Candidate source-archive digest and
extraction/portable-package results belong to the private artifact report, not
to the stable formula's checksum.

## Critical open gates

1. The user Extra Usage OFF declaration expired at **2026-11-05T22:46:34.359Z**.
   It is not renewed from historical messages or this unattended mandate.
2. Current BEST runtime coverage is not globally certified. Internal receipts
   prove loading/observations only for their own current PID/location lifecycle;
   no standard-server or retired fixture receipt substitutes for this proof.
   The latest process/receipt inventory is in the private runtime report.
3. The existing isolated Homebrew harness reaches package installation but
   Homebrew refuses `HOMEBREW_AVOID_NESTED_SANDBOXING` for the host account in
   the privileged `admin` group. No sandbox bypass, group change, real-prefix
   retry or global dependency upgrade was attempted. A disposable, suitable
   CI runner must pass the existing Phase A staging job before publishing.

Both subscription windows were under CRITICAL sustainable-rate pressure at
preflight. No additional AI delegation/Codex workloads were started. The existing
governor remains **MONITOR ONLY**, so its recommended routing is not enforced.

## Mac and preservation

The effective launcher remains `~/.local/bin/opencode-team`, resolving to the
preserved versioned **0.3.7** installation. Homebrew also has **0.3.7**, reached
through a different launcher. Installed `doctor` passes; it explicitly does not
certify model/auth availability. `cleanup status` reports enabled/loaded for the
owned `io.opencode-team.safe-caches` agent. Existing launchd records show prior
exit code 1; successful execution of the next scheduled maintenance has not been
established. Legacy jobs remain untouched, not silently retired or repaired.

BEST and FREE configuration, launchers and maintenance artifacts are backed up
privately with hashes. No personal setup, model/account change, credential read
or export, historical-session mutation, cleanup execution or database replacement
was performed. The existing release and launchers are not removed.

## Rollback and continuation

No real install has occurred, so the Mac already remains on the previous release.
The private baseline and task-only inverse patch support restoring only this
preparation, preserving earlier dirty working-tree work. Check application before
use; never substitute a destructive Git reset. Do not restore the quota-state
snapshot over newer observations or overwrite session databases/credentials.

After the user reconfirms OFF and normal work produces current live receipts for
all BEST processes/locations, re-evaluate the normal `activate` gate. Successful
callback observation is not itself ACTIVE enforcement. Complete Phase A clean
install on suitable CI, then follow the existing immutable tag/archive/SHA,
stable-tap and release workflow. Install/update the effective local launcher only
after those gates pass and a verified idle window, keeping 0.3.7 for rollback.
