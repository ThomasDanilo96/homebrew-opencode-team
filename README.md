# OpenCode Team

Status: public release `v0.1.10`.

## Goal

Package the portable OpenCode Team runtime foundation for distribution through Homebrew.

## Requirements

- macOS
- Homebrew
- Node.js
- OpenCode
- Git
- Python 3, curl, jq, uv, ripgrep
- tmux for BEST and GO bridges
- Codex and Serena for team integrations; `gh` remains optional
- Node.js 22.22.2+, Node.js 24.15.0+, or Node.js 26+

## Usage

```bash
brew install ThomasDanilo96/opencode-team/opencode-team
opencode-team setup
opencode-team doctor
opencode-team best
```

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

`best`, `go`, `openai`, and `daily` are aliases for `start <team>`. Resume is forwarded
to the shared runtime with `--resume ses_...`.

Profiles:

- `BEST`: general multi-agent OpenCode profile with the certified BEST router.
- `GO`: OpenCode Go profile with the certified GO OMO patches.
- `OPENAI`: OpenAI-only orchestration profile with Codex and Serena integration.

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

`setup` installs all team dependencies under the isolated data root, installs the
version-pinned Serena MCP server there, and generates the verified BEST and GO OMO
bundles. It also schedules package-owned BEST tool-output GC and BEST/OPENAI
retention jobs when no legacy maintenance agents are detected. It refuses unsupported
Node versions and does not start a runtime.

When legacy maintenance agents are present, setup reports `DEFERRED` and does not
install duplicate jobs. Disposable setups write and validate LaunchAgent plists under
the test state root without loading them.

## Uninstall

`brew uninstall opencode-team` removes the Homebrew package only. Configuration,
session data, state, cache, and authentication data are not removed automatically.
