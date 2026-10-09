# OpenCode Team

Status: release `v0.1.40`.

## Goal

Package the portable OpenCode Team runtime foundation for distribution through Homebrew.

## Requirements

- macOS
- Homebrew
- Node.js
- Git
- curl, jq, uv, ripgrep
- tmux for GO and the BEST OpenCode fallback
- Codex and Serena for team integrations; `gh` remains optional
- Node.js 22.22.2+, Node.js 24.15.0+, or Node.js 26+

## Usage

```bash
HOMEBREW_NO_INSTALL_CLEANUP=1 brew install ThomasDanilo96/opencode-team/opencode-team
opencode-team setup
opencode-team doctor
opencode-team best
```

`best` launches the OmO Native v5 BEST profile with persistent memory and the
BEST route-gating extension. On first use, migrate the isolated BEST provider
and model configuration with `opencode-team best-native-setup`; run it without
flags to review and approve the import. OpenAI OAuth requires `/login
chatgpt-subscription` inside OmO. The previous OpenCode runtime remains
available as `opencode-team best-opencode`.

The install-scoped `HOMEBREW_NO_INSTALL_CLEANUP=1` prevents an unrelated broken
Homebrew package from aborting this install. It does not change Homebrew's global
configuration. `setup` reuses a compatible OpenCode already installed by Homebrew,
including an existing v0.1.16-era tap installation, or installs Homebrew-core
OpenCode when none is available. No third-party tap trust step is required.

Alternative profiles:

```bash
opencode-team go
opencode-team openai
```

## OpenAI profiles

`opencode-team daily` is the fast, cost-efficient OpenAI-only daily driver for
repository analysis, coding, bug fixes, tests, and medium-size refactors. It
uses Luna by default, escalates selectively to Terra or Sol, and keeps runtime
state isolated from `openai`.

Use `opencode-team openai` for maximum-capability or high-risk work.

Run `opencode-team daily-report` to summarize completed Daily work packets,
token usage, estimated cost, model mix, fanout, and latency. Missing telemetry
is reported as `null`/`unmeasured`.

`go`, `openai`, and `daily` are aliases for `start <team>`. `best` starts OmO
Native; use `best-opencode` to launch the OpenCode fallback. Native session
resume uses OmO's `--resume` / `--continue` options.

Profiles:

- `BEST`: OmO Native v5 with persistent memory, session continuity, and native
  enforcement of the BEST explore/librarian/four-agent routes.
- `BEST OpenCode fallback`: the preserved OpenCode v5 profile, launched with
  `opencode-team best-opencode`.
- `GO`: OpenCode Go profile with the certified GO OMO patches.
- `OPENAI`: OpenAI-only orchestration profile with Codex and Serena integration.

## OpenCode completion notifications

The OpenCode profiles (BEST fallback, GO, OPENAI, and DAILY) send a macOS
notification when the root chat finishes a response. Clicking it brings the
terminal running that tmux session to the foreground and returns to the matching
chat. Setup registers Homebrew's `terminal-notifier` app
in `~/Applications` and sends one test notification to request macOS permission.
Approve the system prompt; macOS does not allow setup to grant notification
permission on the user's behalf. To keep notifications visible until clicked,
set the alert style to **Alerts** in System Settings → Notifications; macOS
automatically hides notifications using the **Banners** style.

## Development

The current repository contains the portable runtime foundation only. Machine-specific
team configuration, user state, credentials, caches, and runtime data are intentionally
excluded.

Run the package checks locally:

```bash
bin/opencode-team version
bin/opencode-team doctor
bin/opencode-team --help
```

Prepare an isolated installation root without starting OpenCode:

```bash
OPENCODE_TEAM_HOME="$(mktemp -d)" bin/opencode-team setup
```

`setup` provisions a private uv-managed Python 3.13 distribution and installs all
team dependencies under the isolated data root, including the pinned OmO Native
runtime and its bundled Bun runtime. It installs the version-pinned Serena MCP
server, resolves a compatible brewed OpenCode provider, and generates the verified
BEST Native and OpenCode fallback profiles plus the GO OMO bundle. It also schedules
package-owned BEST tool-output GC and BEST/OPENAI
retention jobs when no legacy maintenance agents are detected. It refuses unsupported
Node versions and does not start a runtime.

Runtime state is kept under the cache runtime root and published with process
identity, heartbeat, size, and lifecycle state metadata. Use
`opencode-team runtime-status` to inspect runs. `opencode-team runtime-gc` only
reports old `RECLAIMABLE` runs by default; pass `--apply` to remove them. Runs
marked `UNCERTAIN` are never reclaimed automatically.

When legacy maintenance agents are present, setup reports `DEFERRED` and does not
install duplicate jobs. Disposable setups write and validate LaunchAgent plists under
the test state root without loading them.

To upgrade an existing v0.1.16 installation, keep its compatible brewed OpenCode
provider installed and run:

```bash
HOMEBREW_NO_INSTALL_CLEANUP=1 brew upgrade ThomasDanilo96/opencode-team/opencode-team
opencode-team setup
opencode-team doctor
```

## Uninstall

`brew uninstall opencode-team` removes the Homebrew package only. Configuration,
session data, state, cache, and authentication data are not removed automatically.
