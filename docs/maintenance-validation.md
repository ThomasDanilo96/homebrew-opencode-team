# Safe maintenance restoration — 0.3.6 candidate

## Contract

Official runtime stays OpenCode 2.1.4; no fork, server or deletion endpoint is added.
All historical sessions, durable work and credentials are protected. Session analysis
is informational only. SQLite reclaim, backup rotation and the retained 0.3.5 cache
policy are separate operations; a failure must not suppress the others.

The four original sources were readable. The original V2 caller pins
`2.1.0-retention.2` before reaching reclaim/cache tasks and bypasses legacy snapshot
and update handling. Official 2.1.4 `Session.remove` interrupts work and recursively
deletes children; it is deliberately not used for unattended retention. The original
updater's unpinned upgrade and legacy plugin reinstall are deliberately not restored.
Original scripts, fork checkout, old backups and disabled BEST retention are preserved.

## Evidence so far

- RED integration: three intended scheduling failures; Docker failure prevented the
  independent Serena task. `node --test tests/disk-cleanup.test.mjs` reproduced the
  latter after correcting the fixture's recreation of its dated directory.
- GREEN cache isolation: three cache tests passed; Docker failure still returns
  nonzero while the old temporary Serena log is removed.
- Real official 2.1.4 source launcher acceptance passed TUI Home/response, transcript
  resume, `run` and Mini for BEST and FREE, all exits zero. Isolated local-model
  fixtures only; no historical session resumed and no subscription-access claim.
- Source `doctor` passed for official 2.1.4, managed Serena 1.7.0 and the unchanged ECC pin.
- Pre-deployment read-only logical baseline: BEST 641 V2/155 legacy sessions, FREE
  6 V2/2 legacy sessions. All tables/schema/auth hashes captured privately; quick_check
  and foreign_key_check passed. No values, credentials or transcripts are published.
- Local workflow behavioral scenarios passed. This is not a remote CI result.
- Optional real native permission regression passed (one test, zero skips,
  212.6 seconds). An initial harness invocation timed out at 120 seconds; rerun
  used 360 seconds, retaining the test's unchanged 300-second limit.

## Verification and review corrections

- System Python 3.9: 28 focused tests passed, covering WAL/open connections,
  consistent restore, 641-session/history/credential preservation, source SQL
  authorizer denying row mutations, lock contention, timeouts, dry-run bytes,
  unsafe paths/sidecars and independent task failures.
- The initial worker fixtures used non-official `compacting`/`completed`; main
  replaced them with pristine 2.1.4 `time_compacting`/terminal-outcome semantics.
  RED reproduced schema and writer-busy failures; corrected tests passed.
  Existing 0.3.5 state mode 0755 is reused without chmod; new snapshot directories
  remain 0700 and protected files 0600, with writable/shared boundaries refused.
- Independent review initially requested changes for embedded-NUL deduplication,
  interrupted pruning, timeout-retry retention and crash-durable publication.
  Four regressions reproduced all findings (three failures/one error), then passed.
  Typed lossless row hashing replaces SQL dump hashing; retirement renames and
  directory fsync protect recovery; unchanged retries finish retention. Repeated
  full logical verification within the locked run was removed.
- Review follow-up found two recovery edge cases; both were reproduced RED and
  corrected GREEN: retirement retries fsync the parent before any unlink, and
  deduplication compares only the newest three snapshots that will survive pruning,
  publishing a replacement if current data matches an about-to-prune older copy.
- Python branch-inclusive coverage: **89%** (Coverage.py), Ruff passed with the
  existing global-config deprecation warning; Pyright zero errors.
- Full Node coverage suite: **45 passed, two opt-in skips, zero failures**;
  launcher line/branch/function coverage **98.28/81.33/98.11%**. The native
  permission opt-in separately passed; historical Hybrid export opt-in was not rerun.
- Actual disposable LaunchAgent dry-run exited zero, left the fixture database
  byte-identical and created no snapshots. An initial acceptance harness treated
  launchd's “never exited” field as a completed exit; fixed its numeric-exit parser
  without relaxing the zero-exit requirement, then reran successfully.

### Measured disposable data

Incremental fixture: 750 committed pages; main file **3,174,400 → 102,400 bytes**;
WAL **4,152 → 98,912 bytes**. Main-file reduction is 3,072,000 bytes, while combined
main/WAL file lengths decreased **2,977,240 bytes**. These are file lengths, not an
APFS allocated-space or whole-filesystem free-space measurement. No historical
rows were removed. One focused run took 0.028503 seconds; timing is illustrative.

A private consistent representative BEST copy was **711,262,208 bytes** with all
641 sessions. Four changed snapshots took **10.199/9.142/9.857/9.945 seconds**;
an unchanged retry checking three existing snapshots took **12.449 seconds**,
within the 30-second per-profile budget. Exactly three verified snapshots remained.
Only this disposable copy received a synthetic probe table; the live DB was read
through SQLite's backup API, never edited by the rehearsal.

## Release gate

Independent final source review approved proceeding through the gated Homebrew
workflow, with no remaining verified blockers or minimalism findings. System Python
28-test rerun, Ruff, Pyright and final 89% Python branch-inclusive coverage passed.
Actual CLI `cleanup run` on the disposable launchd fixture completed all tasks with
zero exit: one session preserved, verified backup created, mode-0 reclaim correctly
skipped, caches safe, update check informational only. No real cleanup was applied.

Isolated Homebrew package acceptance, remote Phase A, immutable-tag Phase B and
stable clean-install must still pass before publication. No release completion is
claimed by this preparation.
The two pre-existing untracked evaluation documents are outside this release.

## Native V2 permission correction — 2026-10-26

The maintenance implementation above was retained, not reimplemented. Runtime
remains official 2.1.4. Native `/api/config` discovery confirmed these independent
documents, with no project or managed document returned for this Location:

- Standard: `~/.config/opencode/opencode.jsonc`.
- BEST: `~/.config/opencode-team/best/opencode.jsonc`, isolated `best/v2` directory.
- FREE: `~/.config/opencode-team/free/opencode.jsonc`, isolated `free/v2` directory.

Historical standard subagent external-directory denials are explained by the
global `{action: external_directory, resource: '*', effect: deny}`: only Build
and General had later wildcard allows. Explore and Reviewer therefore denied
the user scripts, LaunchAgents and related repositories. Subagents have their
own policies, not their parent's effective grants. Standard now asks outside
trusted boundaries and allows `~/Sites/Github/*`, `~/Sites/Python/*`,
`~/.local/bin/*`, `~/Library/LaunchAgents/*` and the approved OpenCode temp
boundary. Build/General wildcard overrides were removed; LaunchAgent edits deny.
Existing shell safety policies, models, MCP and all other settings were preserved.

BEST already allowed ordinary shell/Git and external directories globally. Its
read-only agent catch-all denied `execute` and unlisted Serena tools; BEST now
explicitly permits Code Mode and read-only navigation while nested shell/edit/MCP
mutations remain denied. Generated BEST directory rules use the same trusted
roots, ask elsewhere, and restrict temp access to `opencode/*`. Native ordered
`permissions` arrays use `action/resource/effect`; last matching rule wins and
agent rules follow globals. Conservative shell approval guardrails cover
irreversible Git, deletion, credential, database and production-management
commands. They are not a shell sandbox and may overmatch command-message text.
FREE permissions and provider policies are unchanged; no paid provider enabled.

Ordinary `git add`/`git commit` succeeded through standard Build, General and a
new BEST CLI session with the acceptance messages. The final real candidate
commit subsequently reproduced the rejection and identified its exact policy;
see the publication blocker below. No runtime/host Git defect is established.

Backups precede edits: standard under
`~/.config/opencode/backups/permissions-v2-20261026T130955Z/`, BEST at
`~/.config/opencode-team/backups/best-permissions-v2-20261026.jsonc`, and repository
pre-edit copies under the approved runtime temp directory. Standard live API
agents reloaded the new rules without a service restart. New CLI sessions did
not use `--auto`; existing sessions' selected models were not changed.

### Actual acceptance

Disposable GitHub/Python repositories `opencode-permission-fixture-20261026`
contain only test data. No destructive command ran against a real repository.

- Standard Build: external patch/write, script/LaunchAgent reads, Node and Python
  tests (one each), add and commit `f535746` succeeded.
- Standard Explore: external GitHub/Python/script reads and Serena pattern search
  succeeded. Standard General wrote both fixtures, ran both tests and committed
  `358d7ef`. Independent Reviewer read all three external sources without edits.
- New standard CLI session `ses_e87a92e04ffeIQH2vyxSknEAx3` read external sources
  and wrote the Python fixture marker without approval.
- New BEST CLI session committed `c57c70f`, with external reads, marker write,
  Node/Python tests and Git add all succeeding.
- BEST native subagents: Explore `ses_e879d21eefferJ7lcmPgXIw04b` read all external
  sources; General `ses_e879d21a0ffeh1GoZEf805ur9i` wrote/read back its marker;
  Reviewer `ses_e879d2047ffeuwJfInC9S71BHH` independently read without mutation.
  General used native `write` rather than requested `patch`; both share `edit`.
- BEST Serena initial instructions, pattern search and Python symbol overview
  succeeded. Standard TypeScript symbol overview and pattern search succeeded;
  Python symbol overview failed because only TypeScript LSP is active there,
  not because of permissions. No MCP/LSP configuration was changed for this task.
- Native safety API: standard hard reset, clean, force push, LaunchAgent edit and
  Reviewer edit resolve to deny. BEST ordinary commits (including `-c`/`-C`)
  resolve allow; hard reset, clean, forced/mirror/refspec push, database/session
  deletion resolve ask. These API checks evaluate resources without executing
  them and do not prove every possible shell spelling is intercepted.
- Permission TDD: two intended RED regressions, then two focused GREEN tests.
  Independent read-only review approved the final source and standard diff.
- Maintenance: 28 Python tests passed; Ruff passed with the existing global
  configuration deprecation warning; Pyright zero errors. Shell/Node/Ruby/Zsh
  syntax checks and workflow behavioral scenarios passed.
- Expanded optional native evaluator suite exceeded its unchanged 300-second
  deadline: incomplete, not PASS. An additional full Node rerun hit the harness
  120-second command limit during concurrent acceptance; it is not a test PASS.
  The earlier full run was 46 passed/two opt-in skips. Later final reruns and
  packaging/release results must be recorded separately below.

No host filesystem denial was observed in the successful live tests. A configured
`ask` can still be rejected by an unattended client, and native policies can
hard-deny after permissions; neither should be bypassed. Setup regenerates the
source rules and preserves the separate FREE policy. The normal stable package
must not be represented as upgraded until its own release/install gates pass.

### Final local rerun

The final full Node coverage run completed with a 360-second harness budget in
132.7 seconds: **46 passed, two opt-in skips, zero failures/cancellations**;
launcher line/branch/function coverage **98.34/81.76/98.25%**. Test assertions and
the optional native evaluator's 300-second limit were not relaxed. Local Gitleaks
could not run because the executable is not installed (exit 127); the existing
remote packaging gates install and run it. The legacy BEST retention LaunchAgent
was confirmed disabled and was not modified or reactivated.

A final requirement check reproduced a separate BEST gap: shell guardrails alone
did not gate direct patch/write of a trusted `private.pem`. A new RED regression
confirmed allow instead of ask. Minimal native `edit` rules now ask for key,
credential, secret and environment files, with a later `.env.example` exception;
read-only roles continue to deny edits, and FREE is unchanged. Three focused
permission tests then passed and independent review approved. Actual native API
checks on the final live BEST config returned ask for `private.key`/`.env`, allow
for `.env.example`/ordinary source, and deny for all four with Reviewer. No key or
credential content was read or changed. Repository payload was frozen again for
final package acceptance; earlier successful local candidate packages are not
evidence for this last edit-rule addition.

The full final credential-safe source rerun passed in 163.8 seconds: **47 passed,
two opt-in skips, zero failures/cancellations**; launcher line/branch/function
coverage **98.35/81.87/98.28%**. A scoped literal-secret pattern scan found zero
matches in nine changed source/test/workflow/package files; this is not a full
credential-store or dependency audit.

Final actual Homebrew acceptance passed for the frozen credential-safe payload:
`opencode-team/permission-validation-xvrrnzfinal/opencode-team-permissions-candidate-xvrrnzfinal`
installed 0.3.6 keg-only/unlinked; `brew test` passed 36 Node tests (one optional
skip) and 28 maintenance tests. Real installed setup ran twice with official
2.1.4 and existing Serena/ECC, preserving generated bytes and FREE isolation.
Source/archive/installed hashes agree for `shared/profiles.mjs`
`889d898516f983d13254c66606f195741b243ec6d99eee9976503eed883fd706` and
`tests/native-profiles.test.mjs`
`fcc7f091b233b2fc81ea0ae08f215911b3017fd792f50a68782b870e1b3178c2`.
Private evidence is under the approved temp root in
`permissions-credential-final.Xv7RrNZ7/`. Stable commands, prior kegs, shared tools,
real profiles/jobs/auth/sessions were preserved. Existing dependencies were reused;
fresh dependency resolution remains a remote gate. No stable checksum uses a
local staging archive hash.

### Publication blocker: reproduced ordinary-commit policy rejection

After final package acceptance, the authorized real command
`git commit -m "fix: restore safe maintenance and trusted development permissions"`
returned `permission.rejected` / `Blocked by configuration policy`.
Read-only inspection of live `/api/config` identified exactly one matching
`tool.use` policy in `~/.config/opencode/opencode.jsonc`:

```json
{"action":"tool.use","resource":"shell:git * restore *","effect":"deny"}
```

V2 whole-command wildcard matching treats the word `restore` inside the commit
message as a match. This is a configuration-policy false positive, not a Git
failure, directory denial, missing shell allow, or demonstrated host restriction.
A hard-deny policy wins after an otherwise allowing permission decision.
The earlier API tests used different commit messages and did not cover this
actual resource; their allow results do not invalidate the reproduced blocker.

The denied command was not retried with a different message, wrapper or tool, and
the deny policy was not relaxed. Publication therefore stopped before a new
candidate commit/push, PR, remote Phase A, tag, Phase B or stable release/upgrade.
The branch remains `prerelease/v0.3.6`, with the maintenance work and permission
fixes preserved in the index/worktree and the two original untracked evaluation
documents untouched. Stable Homebrew remains 0.3.5. Candidate setup persistence
was tested on the isolated final 0.3.6 keg; running the still-installed 0.3.5 setup
would regenerate its older BEST policy, so installed stable setup persistence is
not claimed.

Resolving the remaining policy requires an explicitly permitted policy change
and regressions for destructive words inside normal Git argument strings,
including global `-c`/`-C` options. Simply changing this commit's message would
hide the defect; blanket allow cannot override a configured policy deny.

### Publication resumed after user administrative review

The user subsequently reported completing the administrative permission review
and authorized publication only. No further policy edits are part of this work.
Before resuming, the branch was still `prerelease/v0.3.6`; source and staged
hashes of both permission files exactly matched the final tested/installed
payload above. The prior 47-test Node run, 28 maintenance tests, independent
reviews and final isolated Homebrew acceptance remain applicable; no executable
source changed. Staged whitespace validation passed. The two original untracked
evaluation documents remain excluded. Remote gates and stable installation are
not implied by these local results and must complete separately.
