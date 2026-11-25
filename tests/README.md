# Isolated tests

```sh
bash tests/guardrail/runner.sh        # complete local mock suite
bash tests/guardrail/runner.sh smoke  # installed candidate smoke
bash tests/guardrail/runner.sh packaging  # formula/staging assets and installed fixture smoke
bash tests/guardrail/runner.sh quota  # quota math, routing and subscription-safety mocks
```

The runner requires macOS `/usr/bin/sandbox-exec`; absence is a nonzero failure,
not permission to run without isolation. No credentials, native model traffic,
network provisioning, real cleanup or real LaunchAgent actions are required.

## Boundaries

- Copies the current `bin`, `shared`, `tests`, `Formula`, `completions`, `.github`
  and `VERSION` into a fresh staging directory outside the user's HOME.
- Runs children with an environment allowlist. HOME, OPENCODE_TEAM_HOME, TMPDIR
  and zsh TMPPREFIX point into staging; ambient provider credentials, native test
  binaries, export paths, XDG overrides, NODE_OPTIONS and Docker endpoints are
  not inherited.
- Kernel profile permits writes only inside staging and to standard output
  devices; denies reads of the real HOME, inherited external team root and the
  external sentinel fixture. TCP/UDP connections are denied. Unix socket bind is
  permitted for the disposable Docker socket mock, not outbound connections.
- Launchctl/brew/docker entry points are denied. These are additional guards,
  not a claim that every alias to every installed executable is enumerated.
- Broad read access to system/toolchain files and `mach-lookup` remain necessary
  for macOS/Node. This is a tested containment boundary for this suite, not a
  general-purpose sandbox for malicious programs or a proof against all IPC.
- Negative controls run **before** functional suites. They use only an external
  temporary sentinel, never live DBs, and assert EPERM rather than treating any
  failed connection as isolation. A failed negative control aborts the run.

Python, Node and shell suite entry points reject direct execution outside staged
context. Python additionally confines maintenance paths and SQLite arguments
(including file URIs, bytes and symlinks) to an exclusively owned session root;
unmocked maintenance subprocess calls fail closed. Its cached tempfile root
survives environment clearing inside tests. The subprocess lock regression runs
only beneath the inherited OS sandbox.

Profile path literals are escaped during generation. Generated profiles and all
fixtures are removed only from the runner's own temporary directories.

## Coverage and interpretation

- Python: snapshots, restoration, WAL/reader/writer contention, filesystem and
  SQLite errors, phase/deadline reporting, retention recovery, JSON/exit codes.
- Node: native launcher/config/migration mocks, scoped LaunchAgent lifecycle,
  cache cleanup against fixture files, packaging via a Homebrew Ruby DSL mock,
  completion and staged-formula installation.
- Shell: installed-package smoke and release workflow contracts/mock scenarios.
- Optional native permission evaluation and real Hybrid session exports remain
  skipped without explicitly supplied evidence. The default runner deliberately
  does not inherit these opt-ins; skips are not PASS.

The stable formula references the immutable published tag, not a staging archive.
Stable and staging recipes share the same guarded test surface; the renderer
changes only artifact identity and preserves the installed runner's `smoke`
target. Local Ruby DSL tests are **not** a real `brew install`/`brew test`, remote
CI result, model/auth check or verification of the scheduled 04:15 execution.

`brew test` retains Homebrew's own sandbox for launcher and packaged-asset checks.
The complete installed guardrail smoke is a separate required command in staging,
official-archive and stable clean-install jobs: nesting `sandbox-exec` inside
Homebrew's sandbox fails on macOS. Neither sandbox is disabled, and the installed
smoke still runs all isolation negative controls before any fixture suites.
The trusted PATH prefers the formula's declared `node@22`, avoiding unrelated
preinstalled Node kegs invalidated by Homebrew dependency upgrades.
