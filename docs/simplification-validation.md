# Official runtime simplification — 2026-10-26

## Baseline and access

Both requested repositories passed actual read and temporary-file create/remove
checks using the authorized file tools. No permission bypass was needed. Initial
Team work consisted of two untracked evaluation documents, which remain untouched.
The retention checkout was detached at `5c68e5c`, with substantial dirty/untracked
implementation; none of that work is discarded or staged by this task.

The available previous handoff is the retention repository's `RETENTION.md`.
Its claims were checked against source and fresh tests rather than accepted as
current acceptance evidence. No separate permission-blocked simplification report
was found in the repositories or their Serena memories.

## Complete fork delta

Official baseline: `v2.1.0`, `60c68d145a14127ce633e26aa5fdfb882a7baa6d`.
Tracked working-tree delta: **39 files, 1,742 insertions, 293 deletions**.
HEAD adds just the TUI creation-order test/fix commits; most retention code is
still local work. Untracked sources are essential and included in this audit.

| Area | Changed source and behavior |
| --- | --- |
| Database | `packages/core/schema.json`, `src/database/{migration.gen,schema.gen}.ts`, `src/session/sql.ts`; untracked `src/database/migration/20261024112318_session_use.ts` and `src/session/use.ts`. Adds only `session_use(session_id,token)`, its composite key and cascading session FK. No existing history columns change. |
| Atomic removal | `packages/core/src/bus.ts`, `src/session.ts`: immediate-transaction conditional deletion/projection/history purge; family traversal through parent and fork links, leaf-only target, recent activity, pins, inbox/pending work, suspended claims and recovery references block removal. Ordinary explicit removal remains a separate, unguarded operation, as upstream. |
| Execution ownership | `packages/core/src/session/{execution,session}.ts`: token-owned protection around execution, preparation, mutation, prompt/shell/skill, compaction, revert and child operations. Pins do not expire on silence. |
| Protocol/server | `packages/protocol/{openapi.json,src/groups/session.ts}`, `packages/server/src/handlers/session.ts`: experimental acquire/release `/use` and conditional `/remove-inactive` routes. |
| Clients | `packages/client/src/effect/api/api.ts`, both generated clients, Promise generated types/index and untracked `src/promise/session-use.ts`: independent tokens, acquisition deduplication and ordered release. Generated changes follow the protocol. |
| App | `packages/app/src/new-session/composer-adapter.ts`, `src/session/route.tsx`, `src/shell/tabs/schema.ts`, `src/shell/tabs/tabs.tsx`: pin acquisition before attachment, restored/background tabs, release on close, async creation/navigation ordering. |
| TUI/Mini | `packages/tui/src/component/prompt/index.tsx`, `src/context/{route,session-tabs}.tsx`, `src/mini/runtime.ts`, `src/plugin/api.tsx`: ownership on attachment/restoration, release on replacement/exit, asynchronous tab opening and create-before-navigation correction. |
| ACP | `packages/cli/src/acp/{agent,sessions}.ts`, `src/commands/handlers/acp.ts`: attachment-scoped tokens and shutdown finalization. |
| Tracked tests | App notification/tab tests; CLI ACP wire fixture; core execution/removal tests; TUI status/tab/Mini tests and fixture; TUI new-session creation tests. `.gitignore` adds the retention scratch directory. |
| Untracked tests | CLI ACP `session-use{,.subprocess}.test.ts`; Promise `session-use.test.ts`; core `fixture/session-retention-worker.ts`; protocol `session-retention.test.ts`; server `session-remove-inactive.test.ts`; `script/test-{retention,browser-caches}.py`. |
| Handoff/artifacts | Untracked `RETENTION.md`, compiled `packages/cli/dist-retention-2/` executable/package metadata and Python bytecode. These are preserved, not distribution dependencies for Team. |

No BEST/FREE provider, model or profile-policy implementation belongs to this fork
delta. Existing event contracts remain upstream contracts; ownership is a table,
not a new historical event type.

## Compatibility and transition constraint

The exact installed official runtime is **v2.1.4**, from
`anomalyco/tap/opencode-v2`; its executable resolves into the Homebrew Cellar.
The official `v2.1.4` tag was fetched without modifying the retention worktree.
Compared with `v2.1.0`, its migration list and existing database schema are unchanged
for this compatibility boundary. The session SQL change is typing, not a column
change; historical event changes do not change their serialized shape.

The official migration runner reads completed IDs and iterates its own migration
list. It accepts the extra retention migration without removing it or its table.
No down-migration, pin deletion, database replacement or auto-vacuum reversal is
needed. **Do not delete the extra migration/table to switch runtimes.**

Official clients do not call the fork's `/use` routes; patched clients require
them. Therefore official and patched clients/server cannot be treated as
interchangeable for automatic retention. Most importantly, a patched maintenance
host must never delete sessions while official clients use the same database.
Automatic session deletion must be disabled before actual official launches.
The cache cleaner must not be replaced with ordinary session DELETE or SQL.

**A separate execution-recovery gate also applies.** Every patched profile host
must finish its work and exit normally before the first official host opens that
profile. Startup recovery uses durable claims but process-local ownership; a
second host can otherwise resume work still owned by the first. Preserve all
pending work and source claims, take a consistent recovery backup, and verify
there are no remaining holders before transition. Never clear source claims to
force a switch. The export test below deliberately disables recovery only in its
copy: it certifies historical read compatibility, not mixed-host execution or
live restart/recovery. Existing user hosts are not stopped by this task.

The installed legacy BEST retention job is
`it.danilodantoni.opencode-team.best-retention`; its plist invokes
`opencode-cleanup --v2 --v2-standalone --v2-apply --v2-upgrade-confirmed` at 05:00.
The caller pins `v2.1.0-retention.2`. Its files and retained binaries are recovery
assets, not files that can safely be deleted just because they are now obsolete.

## Original macOS cleanup

The original installed components are `~/.local/bin/opencode-cleanup` and
`~/.local/bin/disk-cleanup.sh`. They are different responsibilities:

- `opencode-cleanup`: legacy session retention, fork-specific guarded V2 removal,
  bounded incremental SQLite reclaim and a call to disk cleanup. Its unrestricted
  legacy entrypoint also performs unrelated update/snapshot maintenance.
- `disk-cleanup.sh`: broad legacy package/application cache cleanup, plus explicit
  browser-only and safe-cache-only modes. The latter limits work to guarded browser
  caches, local Docker build cache and old unopened Serena logs.

The packaged automatic job must contain only this limited cache policy, not the
legacy session/updater/snapshot entrypoints or machine-specific temporary path.
No credentials, session databases/transcripts, persistent MCP browser profiles,
VS Code workspace state, Docker images/containers/volumes or Spotlight settings
are cleanup targets. No live cleanup apply is used as a test.

## Fresh verification evidence

| Check | Actual result |
| --- | --- |
| Fork caller regression, `python3 script/test-retention.py` | Exit 0; 98 passed. Existing ResourceWarnings reported, not hidden. Disposable databases/servers only. |
| Original safe-cache regression, `python3 script/test-browser-caches.py` | Exit 0; 31 passed. Disposable HOME, no live cleanup. |
| Historical sessions under official v2.1.4 | Exit 0; all 641 session projections and 32,305 messages exported through the official authenticated API from a private disposable projection-only copy. Extra pins/migration preserved in the copy. Original opened `mode=ro`; no prompt, resume, deletion or source session writes. Credential/account rows and pending/recovery work were not copied. Copy's execution claims disabled only in the copy. The private copied database was then removed. |
| Historical harness first attempt | Exit 1 from a fixture assertion using `session` instead of the documented `info` response key; corrected the harness, not product code, before the successful full run. |
| Official PTY via installed Team launcher and final source launcher | Exit 0 for BEST and FREE; Home → submit → visible fixture response, resume with prior transcript, `run`, Mini response. All interactive clients closed with Ctrl-C/exit 0. Disposable HOME/Team roots and local deterministic HTTP model; no subscription or credentials exercised. |
| Native delegation, both profiles | Exit 0; actual native `subagent` tool created General and Explore child sessions, completed both and continued the parent. Database parent/agent relationships checked. Local deterministic HTTP model, no real credentials; this is runtime/tool execution evidence, not provider-entitlement evidence. |
| Source database integrity | Exit 0; SQLite `quick_check` returned `ok` through a read-only connection. No repair or write performed. |
| Historical harness failure cleanup | Injected exception before opening the source database: expected nonzero exit; all exact private database files removed. Reviewer re-review closed the privacy finding. |

Temporary reproducibility drivers are in the approved OpenCode temporary directory:
`team-historical-compatibility.py`, `team-native-delegation.py` and the existing
`retention-tui-e2e.py`. Do not publish private transcripts with evidence.

Installer, final package, independent review and release gates are recorded below
only after they have actually run. No release is authorized by partial success.

## Independent compatibility review

Independent review found two operational P1 gates: disable the legacy deletion
job, and finish/close the old hosts before an official host can recover claims.
The handoff now distinguishes these requirements from historical export success.
A P2 in the temporary test harness's failure cleanup was fixed and re-reviewed;
no further P1/P2 code findings were reported in that scoped re-review.

The real legacy BEST job was inspected with native `launchctl`: loaded, not
running, scheduled for 05:00. A separate `lsof` inspection found three OpenCode
processes holding the BEST database. These facts are observations, not permission
to stop the user's hosts. No real official-profile launch, live cleanup apply,
legacy-job removal, credential operation or database migration was performed.
Actual rollout remains blocked until both operational gates are verified.

## Implementation and final verification

Changes are confined to the existing launcher/config owner, its completion,
one necessary safe-only cleanup script, targeted tests and this documentation.
The existing three product dependencies remain necessary: Node runs the launcher,
Git provisions pinned ECC skills, uv provisions Serena. No runtime fork,
additional wrapper, service, plugin or dependency was added. Retention source and
its local modifications are retained as recovery/development assets, not deleted.

The launcher resolves an absolute native executable outside the profile-private
tool bins, without changing BEST's scanner PATH or any profile/model/policy.
Lookup stops at the first eligible executable. Explicit trusted executable
overrides remain supported. Setup adds a single owned native macOS job at 04:15,
without running it immediately. Custom HOME/root setups do not auto-register jobs.
Disable/uninstall removes the owned plist after unload, so login cannot reactivate
it; the preference receipt prevents future setup from silently re-enabling it.
The scheduled script follows Homebrew's stable installation path across upgrades.

Unlike the original script, unsupported Playwright GC is explicitly skipped:
no revision is deleted, no browser is downloaded, and registered package code is
not executed just to inspect a cleanup that cannot run offline safely. Legacy
broad cache purges, package updates, snapshots and machine-specific paths were
not copied into the packaged script.

| Final check | Result |
| --- | --- |
| Full `node --test --test-concurrency=1 --experimental-test-coverage tests/*.test.mjs` | Exit 0; **44 passed, 2 opt-in skips**, zero failed/cancelled. `shared/profiles.mjs`: 98.90% lines, 82.82% branches, 98.11% functions. This is JS coverage, not aggregate Python/TUI coverage. |
| Opt-in native permission evaluator | Exit 0; **1 passed, 0 skipped**, using official v2.1.4. Executed separately; shell resources are evaluated, not executed. The remaining optional Hybrid export audit needs external four-lane evidence; no new cost/model benchmark is claimed. |
| Actual default runtime discovery | Exit 0 for BEST and FREE; official `run` and two real native child delegations completed without an executable override, despite a failing fork sentinel first on PATH in BEST's private bin. Ten local fixture model requests, no credentials. |
| Setup smoke | Exit 0; mock provisioning/launcher, isolated profiles. The final Homebrew run repeats it against the installed candidate. |
| Homebrew workflow contract scenarios | Exit 0; existing/created/timeout/failed/draft/prerelease/wrong-tag cases passed. This is not remote Actions execution. |
| Real Homebrew install/test/uninstall | Exit 0 for source commit `4990489abf4d1ea1a2dc1459297ac2d09771279b`, isolated **keg-only** candidate; `brew test --force` passed in the normal sandbox. Candidate and its new test tap removed afterward. Stable Team keg, tap metadata, links and release archive were not replaced. Local archive SHA-256: `c30f89c9bc3efbcb7a9eeffa25eaf523b34a66f4e9687dca0baa5a8e0df8ced4` (not a release checksum). |
| Actual macOS installer lifecycle | Exit 0; real `launchctl` enable/status/disable/re-enable/uninstall with a new owned label and temporary receipt. No immediate apply, no legacy-job change; owned plist/registration removed after testing. A separate disposable launchd label ran the packaged cleaner `--dry-run`, exit 0, preserving cache/session sentinels. |
| Syntax/lint | `node --check`, Bash/Zsh syntax, formula Ruby syntax, and compilation/Ruff of all three actual embedded Python blocks: exit 0. Ruff reports existing global-config deprecation warnings; that user config was not edited. No separate type checker/build exists for this plain-JS/shell package. |
| Security | Independent source/minimalism review approved all fixes. Limited secret-pattern scan of the task's code diff passed. **Gitleaks is not installed, so its scan was not executed/passed.** No secret/config/credential directories were scanned as a workaround. |
| Diff | Task diff whitespace check exit 0; BEST/FREE configuration/model/instruction definitions were not changed. The two initial untracked evaluation documents remain untouched. |

### Failures found and corrected, not hidden

- Disable originally left a plist discoverable at next login. Behavioral RED
  `4e6048d`, GREEN `f4faf2c`: remove only the exact owned plist after successful
  unload, retaining preference and safe retry after failure.
- Playwright inspection executed package code despite always skipping cleanup.
  The same RED/GREEN pair strengthens nonexecution/preservation and removes the
  entire inspection block rather than wrapping it.
- The scheduled physical Cellar path broke after keg removal. RED `ddb3911`,
  GREEN `edf4874`: preserve the existing launcher's logical installation path;
  regression swaps that symlink and removes the old disposable keg.
- First real Homebrew test failed with sandbox `EPERM` on an irrelevant late PATH
  entry. RED `95a40d7`, GREEN `4990489`: short-circuit discovery. No permission was
  granted, no sandbox was disabled and `EPERM` was not swallowed. The same real
  sandboxed Homebrew test then passed.
- Initial combined coverage/native run exceeded the tool's 300-second deadline;
  no PASS was claimed. The full suite and native permission evaluator were run
  separately and passed. An initial embedded-Python lint extraction omitted its
  actual trailing newlines; corrected extraction passed without product changes
  or disabling lint rules.

The first normal Homebrew candidate install automatically upgraded its transitive
dependency **`icu4c@78` 78.3 → 78.3_1**. This is a real host package change, not a
Team dependency addition; it was not silently reverted. The successful rerun used
a dry-run preflight refusing further dependency upgrades, and performed none.
Both ICU kegs remain installed; stable Team 0.3.3/0.3.4 kegs remain installed.

### Delivery state

**Source candidate verified; live rollout and release withheld.** The original
legacy retention job and old profile hosts have not been disabled/stopped by
these tests. Close them normally in a coordinated window, preserve a fresh
consistent recovery backup and pending work, verify zero holders, and disable
legacy session deletion before the first official-profile launch. Never clear
claims/pins or bypass guards to force this gate.

No version, existing tag, stable formula checksum, shared OpenCode service,
credential, real profile configuration or session was changed. No release or
remote CI success is claimed. Temporary reproducibility drivers also include
`team-launchd-acceptance.py` and `team-homebrew-acceptance.py` under the approved
OpenCode temporary directory; they are not new product infrastructure.
