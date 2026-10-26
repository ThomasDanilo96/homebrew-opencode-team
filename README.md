# OpenCode Team

Two isolated profiles on **standard OpenCode V2**, with one launcher and config
generator (`shared/profiles.mjs`). Native V2 owns agents, tools, permissions,
skills, MCP and sessions. No custom runtime, server, router, daemon, OmO, Codex
bridge or mandatory fanout is installed. macOS setup also schedules the limited
cache-cleanup script described below; it never deletes sessions.

| Profile | Default | Connection |
| --- | --- | --- |
| `best` | OpenAI Sol coordinator + Go workers | Connect OpenAI and Go independently inside BEST |
| `free` | `team-free/mimo-v2.6-flash-free` | Anonymous; no paid credentials |

The stable formula selects a checksum-verified release archive; `opencode-team
version` prints the installed version. Tags are immutable; formula metadata
follows on `master`.
See [Hybrid validation](docs/best-hybrid-validation.md) for comparison and release evidence.

## Setup

Install OpenCode **V2** yourself; V1 and unknown major versions are rejected.
Setup never installs/replaces OpenCode or changes its shared service settings.
Requirements: Node.js 22.16+ (Homebrew uses `node@22`), Git and uv.

The retention fork is not required. Historical compatibility and the safe
transition constraint are documented in
[the simplification evidence](docs/simplification-validation.md). **Disable old
automatic session-retention jobs before using official OpenCode with a database
previously maintained by the fork.** Keep existing binaries, backups and the extra
ownership table for recovery; do not delete or rewrite historical sessions.
Finish pending work and close the old profile hosts normally before the first
official launch; do not run both runtimes against the same active profile.

```sh
opencode-team setup
opencode-team doctor
opencode-team best
# In BEST: /connect OpenCode Go; /connect OpenAI using ChatGPT sign-in.
opencode-team free
```

Setup provisions managed Serena **1.7.0** with uv/Python 3.13 under the dependency
root. ECC comes from `https://github.com/affaan-m/ECC.git`, pinned by
`shared/ecc.lock` to `b92f181b3b748d1abbc2afd94af6aa7d8c8fca29`. Only `skills/`
and `LICENSE` are checked out: no ECC agents, hooks, plugins or orchestrator.
`doctor` checks local versions/dependencies/config, not auth, model requests or
MCP connectivity.

### Automatic macOS cache cleanup

On macOS, normal `setup` registers one native LaunchAgent at **04:15 daily**.
Setup never runs cleanup immediately. The packaged script retains only the
original script's limited cache policy: inactive Chrome cache, local Docker
Desktop build cache older than seven days, and unopened Serena `.log` files older
than 30 days. Uncertain process/path checks skip deletion. Session data,
credentials, configuration, persistent browser profiles, Docker images/containers/
volumes and Spotlight settings are not targets.

```sh
opencode-team cleanup status
opencode-team cleanup dry-run
opencode-team cleanup disable
opencode-team cleanup enable
opencode-team cleanup uninstall  # run before uninstalling the package
```

Disable/uninstall persists across setup and login. Only the exact owned agent is
removed; legacy user scripts/jobs are never overwritten. Playwright revisions are
preserved: its download-capable installation command is not used for unattended
GC. No additional daemon, runtime wrapper or dependency is installed.

Custom `HOME` or `OPENCODE_TEAM_HOME` setups skip automatic scheduling. Explicit
`cleanup enable` requires the actual login HOME; a custom Team root stores only
the ownership/preference receipt, not a different macOS user's schedule.

### BEST code quality and browser checks

BEST alone configures official `@playwright/mcp@0.0.83` over native V2
`mcp.servers`, with Code Mode, headless isolated Chromium, no automatic snapshots,
no image responses and no page-provided WebMCP tools. npm resolves the exact
version on first use; no `@latest` is distributed. Install its matching official
browser (not personal Chrome) when needed:

```sh
npm exec --yes --package=@playwright/mcp@0.0.83 -- playwright install chromium
```

The BEST instructions use diff-first checks, not an automatic whole-repository
audit. Ruff, jscpd, Vulture, ast-grep, Semgrep, Hadolint and Trivy are on-demand
CLI tools, not extra MCP servers or hooks. BEST adds its private `bin` and
`quality/node_modules/.bin` under its data root to PATH; FREE does not.
Setup does not install scanners or change system Python. Host Homebrew scanners
remain ordinary host executables, not an isolation/security boundary.
See [scanner installation and fixture evidence](docs/best-quality-scanners.md)
and [browser/integration results and release blocker](docs/best-quality-validation.md).

BEST overrides only ECC's `documentation-lookup` skill with the official Context7
CLI workflow (`npx --yes ctx7@0.8.1`), installed on demand in BEST's private npm
cache. No global package, additional MCP or automatic authentication is needed;
telemetry is disabled. The skill is loaded only for uncertain APIs/native
alternatives, project-version documentation or disputed contracts. Anonymous
queries can be rate-limited; missing documentation is reported, not invented.
Comments/docstrings must explain real non-obvious contracts, not narrate code.
Targeted Ruff D301/D400/D415/D419 checks existing docstrings without a blanket
missing-docstring policy. See [0.3.3 validation](docs/best-context7-validation.md).

## BEST Hybrid: strong coordinator, economical workers

| Responsibility | Native model |
| --- | --- |
| Build: implementation, tests and integration | `openai/gpt-6.1-sol#low` |
| Optional Plan / independent Reviewer | `openai/gpt-6.1-sol#medium` |
| Specialist: complex scoped implementation or critical analysis | `openai/gpt-6.1-sol#medium` |
| General | `opencode-go/longcat-2.0` |
| Explore | `opencode-go/mimo-v2.6-flash` |
| Title | `openai/gpt-6-luna#low` |
| Summary / compaction (continuity retained) | `opencode-go/minimax-m3` |

Build executes ChatGPT-prepared work, validates supplied commands against the
actual code and permissions, and reports verification evidence. Small tasks stay
local. Normal work uses two or three useful independent lanes. Suitable structured
mandates prefer Explore, two separate General sessions and Specialist, with disjoint
writer files, followed by Reviewer after implementation. General is reused, not
duplicated as Coder A/B. Fewer lanes are correct when four useful independent jobs
do not exist; the coordinator explains why. Plan remains optional, not a routine
second planning cycle. There is no fixed fanout, router, scheduler, hook or automatic
high/max escalation. `shared/best-hybrid.md` supplements BEST only; FREE's existing
instructions and configuration remain unchanged.
BEST prioritizes the smallest readable, safe solution with demonstrated necessity
for each addition. Significant changes require a concrete minimalism review;
unnecessary abstractions must be removed before delivery. These are native agent
instructions, not a custom enforcement gate or a universal behavior guarantee.
Subscriptions combine **across agents**, not inside one model request; this is
not a measured savings or comparative model-performance claim.

V2 drops a variant placed only on the root `model`, so BEST also sets Sol's native
per-model `settings.reasoningEffort: low`. Build selects `#low`; Plan/Reviewer/Specialist
select `#medium`. Explicit session/CLI variants take precedence. Setup changes
defaults for new sessions, not stored historical selections: use `/models` there.
Changing a primary agent alone may retain the session model; children use their
own configured models. For an explicit planning run:

```sh
opencode-team best run --agent plan --model 'openai/gpt-6.1-sol#medium' "Plan this change"
opencode-team best run --model opencode-go/minimax-m3 "Reply OK"
```

Both connections are required. An explicit unavailable Go model fails; an
implicit native model selection can use an available OpenAI model and is not
proof of Go access. Use **ChatGPT sign-in** for OpenAI subscription usage, not a
separately billed API key. BEST allows only `openai` and `opencode-go`, not the
pay-as-you-go `opencode` provider. Quota exhaustion is an error, not a paid
fallback. **Disable Go Console's “Use balance”** to avoid extra-credit consumption
after its allowance; local configuration cannot enforce that server-side option.

### Shared rules, immutable classic configuration

BEST remains a native **`--standalone`** environment: classic's OpenAI-only
provider policy stays intact while BEST permits Go. Setup never patches classic
config, imports its provider policies, or copies its credentials/sessions.

When present, BEST references the original **`~/.config/opencode/AGENTS.md`** via
native `instructions`, followed by profile guidance. It is not copied, written or
rolled back; later requests read user edits from the same source. BEST's explicit
model roles specialize shared role labels without importing classic config,
hidden harness instructions or permissions. A missing default rules file is
reported; an explicitly selected missing/non-file source fails before config
replacement. FREE does not automatically gain this shared file.

Build/General implement. Plan/Explore/Reviewer have deny-by-default read-only tool
allowlists: no shell, edits, delegation or MCP mutators. Serena read tools are
allowed individually and Code Mode is disabled. These permissions are **not an
OS sandbox**. Build uses Serena's `initial_instructions`, relevant skills and TDD.

## CLI and storage

```sh
opencode-team start best run "Explain this project"
opencode-team best -s SESSION_ID
opencode-team free run "Fix the regression and run the tests"
opencode-team best auth list
opencode-team best api get /api/mcp
opencode-team config best
opencode-team version
```

The launcher preserves native arguments, exit status and termination signals,
adding `--standalone` in command scope. Resume uses native `-s`, not `--resume`.
Do not use explicit server/attach/service options to connect to classic's shared
service. Some V2 commands reject standalone; see [compatibility notes](docs/opencode-v2-compatibility.md).

| Kind | Default root |
| --- | --- |
| Config | `~/.config/opencode-team` |
| Data | `~/.local/share/opencode-team` |
| State | `~/.local/state/opencode-team` |
| Cache | `~/.cache/opencode-team` |

Roots are independent of ambient XDG variables. `OPENCODE_TEAM_HOME=/absolute/path`
instead uses its `config`, `data`, `state`, `cache` children; HOME must exist.
Config lives at `CONFIG_ROOT/PROFILE/opencode.jsonc`, clean V2 discovery at
`CONFIG_ROOT/PROFILE/v2` (XDG config in `v2/xdg-config`). Existing native data stays
at **`DATA_ROOT/PROFILE/data/opencode`**. State/cache and `SERENA_HOME` are
profile-local. Historical copied plugins/agents/OmO assets are not loaded.

Inherited `OPENCODE_*`, XDG and credential-like environment overrides are stripped
from native launches, including shell-tool tokens and SSH auth sockets. Use
explicit profile-local connections, not ambient credentials.

Explicit setup options:

- `OPENCODE_TEAM_OPENCODE_BIN=/absolute/path/to/opencode`: trusted V2 executable.
- `OPENCODE_TEAM_DEPENDENCY_ROOT=/absolute/path`: dependency content only.
- `OPENCODE_TEAM_ECC_SOURCE=/absolute/checkout`: clean local skills/LICENSE Git
  source; its actual commit is reported and may differ from the official pin.
- `OPENCODE_TEAM_BEST_MODEL=openai/MODEL_ID`: Build/Plan/Reviewer; must support
  low/medium. `OPENCODE_TEAM_BEST_GO_MODEL=opencode-go/MODEL_ID`: General only;
  summary/compaction retain the verified continuity model. Setup does not verify
  alternate-model entitlement.
- `OPENCODE_TEAM_RULES_FILE=/absolute/path/AGENTS.md`: another existing common
  rules source, referenced only; keep it outside generated profile files.

## Migration and rollback

Setup transactionally manages only two configs and two profile instruction files.
Changed files are backed up at `CONFIG_ROOT/backups/BACKUP_ID` (directories 0700,
files 0600). Unchanged setup does not rewrite them or create another backup.
Both profiles are preflighted before replacement; writes use atomic rename.
A journal restores prior configs after write failure or on the next setup after
interruption. Launch checks lock/journal before and after native version discovery.
A stale `.setup-lock` requires owner inspection: verify no setup is running,
remove **that lock only**, then rerun setup for journal recovery.

```sh
opencode-team rollback BACKUP_ID
```

Rollback backs up the current configuration, then restores owned config paths
only—never databases or credentials. Back up profile data separately before V2
database migration; unknown DB formats are not converted by this package. A
restored V1 config is archival: never run V1 against a migrated DB.

V2 accounts live in SQLite. Preserved `auth.json` does not establish imported
accounts; check `best auth list` and prefer independent `/connect`. Intentional
native migration requires a secure **V2 Credential.Entry array**, not the legacy
object (`Expected array`). Protect exports with 0600 permissions and never share
classic's rotating OAuth refresh token between independent stores.

Historical profile data, backups, caches and LaunchAgent files are not deleted.
Removed commands (`daily`, `openai`, `go`, `best-ecc`, `best-native`, `deep-audit`
and runtime/maintenance aliases) fail rather than silently redirect. Owners must
explicitly unload obsolete OS jobs; setup does not manage them.

## FREE boundary

Native `provider.use` filters provider IDs, not models. FREE therefore uses a
singleton `team-free` provider without canonical catalog inheritance, at
`https://opencode.ai/inference/openai/v1`, with empty API key/Authorization and no
credential environment. All other providers are denied, including historical
paid accounts. Every primary, child and maintenance agent selects the same free
model; ordinary model/agent overrides cannot select a paid catalog fallback.
Outages/rate limits must fail, not consume a paid account.

This is **not an adversarial billing sandbox or perpetual free-service promise**.
Trusted project/system/Console config, plugins and host shell/network authority
can change boundaries. Do not add credentials, alter the endpoint/header or run
untrusted project config expecting isolation. The 128k/8192 limits are local
budgets; zero catalog cost is not an invoice audit. MiMo free-period inputs may
be used to improve the model: do not submit secrets or confidential data.

## Verification

See [test commands and boundaries](tests/README.md), [recorded validation and
pending rollout checks](docs/validation.md), and [V2 compatibility/sources](docs/opencode-v2-compatibility.md).

## Release preparation

The workflow deliberately separates candidate testing from publication. The
following is the release procedure; completed gates are recorded in validation:

1. After approval, commit and push the reviewed source to `prerelease/vVERSION`
   using the candidate `VERSION` (currently `0.3.3`).
   Run **Homebrew Install** manually on that branch: Phase A installs the exact
   candidate archive into an ephemeral tap. Local tests are not remote CI evidence.
2. Only after Phase A succeeds, authorize the immutable `vVERSION` tag on the
   **same commit**. The tag workflow validates the published source archive.
3. Measure that official archive's SHA-256, update the stable formula URL/checksum
    together, and push the metadata commit. The `master` push validates the clean
    stable-tap install. For an explicit checksum recheck, dispatch on `vVERSION`
    with `official_archive_sha256` (not on the later formula-metadata commit).
4. Enable `publish_stable_release` only after those gates pass. Install/upgrade
   the stable package separately; never migrate credentials automatically.

Do not replace the old checksum with the local candidate archive's checksum,
retag an existing release, or claim the candidate is available from the stable tap.
