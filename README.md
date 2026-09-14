# OpenCode Team

Status: release candidate. Release URL and SHA256 remain pending until publication.

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

`best`, `go`, and `openai` are aliases for `start <team>`. Resume is forwarded
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
bundles. It refuses unsupported Node versions and does not start a runtime.

## Uninstall

`brew uninstall opencode-team` removes the Homebrew package only. Configuration,
session data, state, cache, and authentication data are not removed automatically.
