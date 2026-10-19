# Native V2 validation

Recorded on **2026-10-19**, including the final 0.2.0 candidate cleanup rerun.
Public profiles are only BEST/FREE. The current architecture is in [README](../README.md).
Superseded Go-coordinator/OpenAI-Expert experiments are not the shipped contract.

## Current source verification

| Executed check | Exit | Result |
| --- | --- | --- |
| `node --test --experimental-test-coverage tests/*.test.mjs` | 0 | **25/25**, zero skips/failures |
| V8 coverage, `shared/profiles.mjs` | — | **100% lines / 86.73% branches / 97.83% functions** |
| `bash tests/setup-smoke.sh` | 0 | Packaging/config smoke passed using mocks |
| `bash tests/homebrew-workflow.test.sh` | 0 | Release gates and actionlint passed locally |
| `actionlint .github/workflows/homebrew-install.yml` | 0 | Workflow syntax valid; not a remote CI run |
| `bash -n bin/opencode-team tests/setup-smoke.sh tests/homebrew-workflow.test.sh` | 0 | Bash syntax |
| `zsh -n completions/_opencode-team` | 0 | Zsh syntax; completion evaluation also covered by tests |
| `node --check shared/profiles.mjs` | 0 | JavaScript syntax |
| `ruby -c Formula/opencode-team.rb` | 0 | Syntax OK |
| `ruby -c .github/scripts/render-staging-formula.rb` | 0 | Syntax OK |
| `shellcheck bin/opencode-team tests/setup-smoke.sh tests/homebrew-workflow.test.sh` | 0 | Clean; intentional SC2016 literal workflow matching documented |
| Scoped `git diff --check` | 0 | No whitespace errors |
| Scoped source secret-pattern scan | 0 | No private-key/literal-token pattern matches in 19 candidate files; not a credential-store audit |
| Documentation links/fences | 0 | Local links resolve; fenced blocks balanced |

All checks in this table were rerun after the candidate code fixes.
There is no configured TypeScript build/typecheck or JS lint pipeline to claim.
The Node packaging suite uses an executable **Ruby DSL mock**; actual Homebrew
installation/testing is recorded separately below. No live model traffic is part
of the source suite.

Behavioral coverage includes dispatch, argument/native resume forwarding, exits
and interrupts, environment isolation, role models/effort, read-only tool policy,
original shared-rules references, config/data path confinement, old auth/session
byte preservation, symlink/V1 rejection, dependency failure safety, idempotency,
restrictive backups/rollback, injected EIO recovery, pending-journal recovery and
concurrent lock/version-probe refusal. Packaging tests launch outside source cwd
and retain release-identity/staging safety checks.

## Important RED → GREEN and migration evidence

These are historical regression results, not new runs or current failures.

| Change | Observed RED | Verified GREEN |
| --- | --- | --- |
| Native profiles/config/migration | `node --test tests/native-profiles.test.mjs`: exit 1, 7/8 failed on old V1 behavior | Initial replacement suite 8/8, exit 0 |
| Formula dependencies/completions | `node --test tests/packaging.test.mjs`: exit 1 on obsolete dependencies/profile entries | 2/2, exit 0 |
| Ambient credential isolation | Exit 1, inherited `OPENAI_API_KEY` assertion | Exit 0 after environment scrubbing |
| Managed Serena reuse | `--test-name-pattern='managed Serena\|fresh provisioning'`: exit 1, unexpected uv install | Same target 2/2, exit 0 |
| SIGINT | `--test-name-pattern='SIGINT'`: exit 1, child remained alive | Exit 0 after interrupt forwarding |
| ECC checkout boundary | Fresh-provisioning regression failed on missing anchored non-cone patterns | Final suite passed with only skills/LICENSE checked out |
| Native standalone placement | Real V2 2.0.32 import/run: exit 1, unrecognized flag before subcommand | Flag moved into command scope; real commands exited 0 |
| Provisioning and startup race | Missing dependency-local Python dir; setup could start during version probe | Local `UV_PYTHON_INSTALL_DIR` and lock/journal checks on both sides of probe |
| Current coordinator/shared rules | Focused tests exit 1, 0/4 | Same target exit 0, 4/4 |
| Sol low effort | Targeted model/override tests exit 1, 0/2 | Same target exit 0, 2/2 |

The combined native-placement/provisioning/race command was
`node --test --test-name-pattern='standalone is passed|launch refuses|fresh provisioning' tests/native-profiles.test.mjs`:
**RED exit 1 (0/3), GREEN exit 0 (3/3)**. Independent read-only review confirmed
the blocking findings closed. The packaging mock's initial system-Ruby syntax
issue was fixed and the intended RED rerun before production packaging changes.
The original launcher initially ignored the mock binary override and stopped at
a missing V1 fallback: that failure was **not** live acceptance.

Fresh real V2 bootstrap did not reliably import legacy `auth.json`; native import
of its object failed with `Expected array`. Accounts must be checked through
native `auth list`; independent `/connect` or intentional secure V2 array import
is required. Config rollback never reverses native database migration.

The classic-isolation regression was a **passing confirmation**, not a fabricated
RED/fix: an OpenAI-only, read-only classic fixture retained bytes, mtime and mode
while BEST used its own config/XDG paths, Go allowlist and native standalone flag.

## Live acceptance: authenticated OpenAI + Go

The real repository launcher ran in disposable HOME/team roots under the approved
temporary area. Real setup/doctor exited **0**, provisioning pinned Serena/ECC.
The user connected Go directly through native login into temporary BEST; an
independent, authorized OpenAI test connection was already there. No classic
credential was read/copied; no key was put in chat, the repository or logs.
Native auth/model listings confirmed both connections and configured Go models.

The current role split was verified from **native session exports**, not model
self-reports. No child model overrides were passed:

| Role | Confirmed native model | Result |
| --- | --- | --- |
| Build | `openai/gpt-6.1-sol` | Native per-model `reasoningEffort: low`; Serena, ECC skill, delegation/integration |
| Explore | `opencode-go/mimo-v2.6-flash` | Read-only source/contract inspection |
| General | `opencode-go/minimax-m3` | Actual source fix and executed RED → GREEN |
| Reviewer | `openai/gpt-6.1-sol#medium` | Independent read-only PASS |

In disposable `go-live-project`, five tests covered `normalizeSlug`. Parent RED
was `node --test`: **exit 1, 1 pass / 4 failures**. General reran RED
(`EXIT_CODE=1`), edited **only `src/slug.js`**, then achieved **5/5, exit 0**
(`EXIT_CODE=0`). Build and the outer harness independently reran **5/5, exit 0**.
Test/package/AGENTS hashes were unchanged. Combined BEST run exited **0**; resume
with native `-s` exited **0**, retained the parent ID/source and reran **5/5**.

Explore's static report incorrectly predicted five failures, rather than the
actual four. Executed tests are authoritative. Reviewer reported no defect but
noted optional punctuation/Unicode coverage missing from this small fixture.
This is functional acceptance, **not** a load/performance or comparative benchmark.

Useful native sessions:

- Parent: `ses_eabdb6dfdffezSxKIvjB5ehsga`
- Explore/Go: `ses_eabdb3692ffeJDNUO6N2smGB44`
- General/Go: `ses_eabda118bffe12lkdbECweMfiY`
- Reviewer/OpenAI: `ses_eabd94e26ffeCAot7ZfRFBXUD7`

Earlier current-config checks also verified the original shared AGENTS.md was
loaded by both parent and native Reviewer without file/tools in the answer task:
both returned its heading and exact `is_ready`, `errors`, `warnings`,
`preflight_profile` contract names (Reviewer `ses_eac3426ccfferffBaduYDUQNik`).
The authenticated native catalog listed Sol low/medium/high/xhigh/max, with low
resolved through native settings and the ChatGPT OAuth backend. A default BEST
run without `--model` exited **0**, ran **4/4** tests, and exported Sol
(`ses_eac2da978ffeMFfMmtxvqrqAUo`); this established settings, not billing savings.
Before Go login an explicit Go model failed `Model unavailable` (exit **1**),
while implicit selection succeeded through available OpenAI. That earlier outcome
was not Go acceptance; actual Go operation is now verified above.

## FREE and immutable classic checks

- After BEST Go login, FREE `auth list` exited **0**: **No authenticated
  integrations**. Actual anonymous reply `FREE_STILL_ANONYMOUS_OK` exited **0**;
  native export confirmed `team-free/mimo-v2.6-flash-free`.
- Earlier FREE model listing was exactly that singleton. A real fixture edit
  achieved RED **1 pass/3 fail, exit 1** → GREEN **4/4, exit 0**, unchanged tests,
  working Serena and native resume (`ses_eac4ec860ffeUdwTgHDFwv1Ops`).
- Explicit FREE overrides `--model openai/gpt-6.1-sol` and
  `--model team-free/gpt-6.1-sol` each exited **1**, `Model unavailable`, without a
  paid request. Zero recorded inference cost is not an invoice audit.
- Actual classic `opencode.jsonc`, `cli.json` and `AGENTS.md` retained SHA-256,
  mtime and mode, including the pre-Go-login snapshot. No classic config/account/
  session, shared service setting, original profile store or other repo changed.

Evidence remains outside the repository in the approved temporary
`team-refactor-evidence/`: `go-live-model-proof.json`,
`acceptance/go-live-export-*.jsonl`, run/resume logs,
`go-live-parent-verification.log`, `classic-preservation-check.json`, and
`go-live-classic-before.json` / `go-live-classic-after.json`. Initial dirty-tree
snapshots and `native-coverage-delivery` are retained there too.

## Cleanup and installed Homebrew candidate — completed

`VERSION` is now **0.2.0**, unpublished. The stable formula's existing 0.1.66
URL/checksum remains immutable until the actual new archive is published.
The candidate archive was built from the current dirty worktree, not a release
commit; generated Playwright snapshots were excluded. No commit/push/tag occurred.

Cleanup included shared-rules alias rejection before setup can overwrite the
source, noninteractive ECC Git protections including partial-clone checkout,
and shipping only portable tests rather than checkout-specific test assets.
Each corresponding regression failed before its fix and passed after it.
The workflow now defaults to read-only repository permissions (release write
access remains explicit), uses noninteractive Git and drops unused outputs.
The published 0.1.66 checksum regression uses a pinned baseline, not HEAD.
Four documents were consolidated, **901 → 453 lines** at that boundary, before
adding final rollout evidence. An independent review identified the checkout and
HEAD-baseline gaps, then confirmed both fixes by source inspection.

| Executed installed-package check | Exit | Result |
| --- | --- | --- |
| Homebrew candidate install | 0 | `opencode-team/refactor-validation/opencode-team-candidate`, 0.2.0, keg-only |
| `brew test` on final candidate | 0 | Actual formula test, installed launcher, version/help, Zsh and isolated setup smoke |
| `brew audit --strict --formula` on candidate | 0 | Clean after correcting staging-only metadata |
| Installed BEST live run | 0 | Sol parent → native General using **Go MiniMax M3**; actual **5/5** tests passed |
| Installed FREE live run | 0 | `BREW_FREE_OK`; export confirms anonymous singleton model |
| Installed payload comparison | 0 | Eight executable/config/test/completion payload files match source bytes |
| Classic/native preservation | 0 | Config/rules SHA-256, mtime, mode unchanged; native OpenCode target and bytes unchanged |

Homebrew used existing Git, node@22 and uv with `--ignore-dependencies`, automatic
updates/cleanup/dependent checks disabled: this validates packaging with installed
dependencies, **not fresh dependency resolution**. Its developer-option warning
was not hidden. No native OpenCode formula was installed, trusted or replaced.
Homebrew automatically trusted only the newly installed candidate formula;
existing untrusted taps were not enabled.

The first candidate audit reported a redundant staging `version` and uppercase
`keg_only` reason; local metadata was corrected before exit 0. An attempted
`brew reinstall --ignore-dependencies` was rejected (exit 1); only our new candidate
keg was removed and reinstalled with `brew install`. Existing packages were not
removed. One payload check initially looked for the completion in `libexec` and
failed; checking its actual `share/zsh/site-functions` destination passed.

Installed native-export sessions: parent `ses_eabb81cf5ffeT8Njbxqi6dlOta`, General/Go
`ses_eabb7fca2ffe7xzrGjwftooGrh`, FREE `ses_eabb7b2c5ffe6ZhXd429qXVFWo`. They confirm
`openai/gpt-6.1-sol`, `opencode-go/minimax-m3`, and `team-free/mimo-v2.6-flash-free`.
The installed launcher used existing disposable acceptance roots; no credential
copying was needed.

The normal `/opt/homebrew/bin/opencode-team` still resolves to **0.1.66.2**.
Invoke the candidate explicitly without changing shell startup files:

```sh
/opt/homebrew/opt/opencode-team-candidate/bin/opencode-team version
```

Do not run setup on ordinary profiles merely to try the candidate. Candidate
archive, check logs, model proofs and preservation comparisons remain under
`team-refactor-evidence/package-candidate/`. That archive predates this final
documentation-only report; installed payload bytes match final source.

## Historical candidate rollout boundary

- GitHub Actions on this source and fresh stable-tap installation: **pending an
  authorized commit/push**. The latest inspected successful run, `39079614524`,
  tested old SHA `18dd15f7fbba1a2866a48ceeafce46b71584f7d0`, not this candidate.
- Official 0.2.0 URL/checksum, GitHub Release and replacement of the normal Team
  command: **pending release gates and authorization**, as outlined in README.
- Disposable live connections do not establish normal installed BEST auth; check
  that independently after installation without automatic credential copying.

**Not run:** interactive TUI acceptance, deliberate OAuth expiry/refresh,
long-context/load tests, comparative model benchmarks or invoice audit. Go's
server-side “Use balance” was not inspected/changed; no unlimited allowance or
disabled extra-credit spending is promised. Free availability/pricing/privacy
and trusted project/system/Console override risks remain as documented in README.

Historical reduction only: at the **initial refactor boundary**, measured against
the captured **starting dirty worktree**, the code diff was 812 added / 32,045
removed (**31,233 fewer lines**). This excludes docs/locks/generated artifacts
and later revisions; it is **not the current cumulative LOC measurement**.

## Official 0.2.0 archive and stable formula rollout

The user authorized commit/push, then tag, publication and local stable update.
The immutable tag `v0.2.0` selects `cfa40169ba172a10923e8dc40d79b2356849d369`.

| Remote gate | Actual result |
| --- | --- |
| Phase A, run `39258569474` | SUCCESS, including `prepublication-staging` installation/tests |
| Phase B, run `39260462896` | SUCCESS, including `official-archive-validation` installation/tests |

The official archive SHA-256 was independently measured locally:
`d38a6a01d1bd20eb823776cabbd63589a12bdb979046ce86244f5e5a49d949a2`.
All eight executable/config/test/completion payload files match tested source.
The stable formula now points to that archive and checksum, not the earlier local
candidate tarball. The immutable tagged README retains its prepublication record;
the current rollout evidence and formula metadata follow on `master`.

Stable-tap clean-install, GitHub Release publication and normal local Team package
upgrade were the next gates at that boundary, resolved below; they were not
outcomes claimed by the two archive runs.
The REST monitor exhausted its quota; read-only GraphQL check-suite results
confirmed both remote gates without changing authentication or permissions.

## Stable release and normal local installation — completed

- Stable tap run `39261157211`, master `e53120001aabc1739366a4cb1f9d98fcde3ca9d9`:
  **SUCCESS**, including `clean-install`, formula test and strict audit.
- GitHub Release `v0.2.0` was published at **2026-10-19T13:38:37Z**; native
  `gh release view` confirmed the tag, published timestamp and non-draft,
  non-prerelease state. The immutable tag still selects the tested candidate SHA.
- Publication run `39261755253` passed its evidence gates but reported **FAILURE**:
  GitHub returned **HTTP 504 after creating the release**. This failure is retained
  as evidence, not relabeled green or followed by release deletion/recreation.
- The workflow now verifies actual stable release state after creation errors and
  accepts an already published release without replacing it, after the same
  immutable-tag/Phase B/stable-install gates. Mandatory final lookup still rejects
  missing releases, drafts and prereleases. Behavior tests run the actual shell
  block against mocks: existing/create/post-create-timeout succeed; true failure
  draft, prerelease and wrong-tag fail. RED rejected the existing release; all
  seven final cases passed after the fix.
  Independent review identified a mock gap; the existing-release case now also
  explicitly asserts zero creation attempts. Remote confirmation follows via the
  normal source/install and publication-dispatch gates; no tag/archive is changed.
- Local `brew upgrade` installed **only OpenCode Team 0.2.0**. The usual
  `/opt/homebrew/bin/opencode-team` now resolves to the stable 0.2.0 keg. Prior kegs
  remain; automatic updates, cleanup and dependent upgrades were disabled.
- Actual stable `brew test`, `brew audit --strict`, `version`, `setup` and `doctor`
  all exited **0**. Setup created configuration backup
  `2026-10-19T13-38-34.123Z-4bbbb2fc-2cb9-4028-bb33-4c979226ccbe` and imported no auth.
- Normal BEST already reports stored **Go API key and OpenAI OAuth**; FREE reports
  **no authenticated integrations**. Neither credential store was copied/exported.
- A live run through the normal installed launcher and normal BEST roots delegated
  Sol → Go General, executing **5/5 tests, exit 0** in the disposable fixture.
  Native exports confirm `openai/gpt-6.1-sol` parent
  `ses_eab9b5f0bffeJTC7dw47im5zQb` and `opencode-go/minimax-m3` General
  `ses_eab9b47aeffe11h8o7ZyRtsP4Y`. Normal FREE replied `STABLE_FREE_OK`; its export
  confirms only `team-free/mimo-v2.6-flash-free`.
- Classic `opencode.jsonc`, `cli.json`, original `AGENTS.md` and native OpenCode
  executable remain unchanged by checksum/mtime/mode and executable-target checks.
  Final evidence is in `package-candidate/stable-model-proof.json` and
  `stable-classic-before.json` / `stable-classic-after.json` outside the repository.

The candidate keg remains separately installed but is not linked as the normal
command. Historical data, backups and OS jobs remain preserved; no OS-job cleanup
or unrelated repository changes were performed. The long-context/OAuth-expiry,
comparative-benchmark and billing limitations above still apply.
