# OpenCode V2 compatibility notes

The V1/OmO implementation was removed, not ported. Profiles use native V2 agents,
permissions, skills, MCP and sessions; there is no V1 fallback. See [README](../README.md)
for current roles/storage and [validation](validation.md) for executed evidence.

## CLI and discovery

- The launcher requires a parseable V2 version. Version/config presence and
  `doctor` do not prove network, OAuth, model or MCP operation.
- With real **V2 2.0.32**, `--standalone` must be in subcommand scope. `run`,
  `models`, `auth`, `session` and `api` accepted it; `mcp list` and `debug config`
  rejected it. The launcher preserves native errors rather than removing isolation.
- Use a supported API/session and an actual Serena call for MCP acceptance. An
  empty lazy MCP list before a session loads is not proof of failure.
- Standalone avoids classic's shared service; explicit server/attach/service
  options can change that boundary. Project/system/Console configuration remains
  relevant; profile config and tool permissions are not an adversarial sandbox.

## Model selection and policies

- Root `model` currently drops `#variant`; agent/command references retain it.
  BEST uses Build `#low` **and** native per-model `settings.reasoningEffort: low`.
  Optional Plan/Reviewer use `#medium`. Explicit session/CLI variants can override
  the default; historical sessions are not rewritten.
- Selecting a primary agent by ID does not necessarily change a session's stored
  model. Native children select their own configured models; overriding all of
  them with the parent's model defeats the intended role split.
- Catalog presence is not entitlement. Without Go connected, implicit native
  selection was observed using available OpenAI; explicit unavailable Go selection
  failed. Both Go and OpenAI are now live-tested in disposable BEST roots.
- `provider.use` filters **provider IDs**, not models. FREE uses its own singleton
  `team-free` provider, no canonical catalog inheritance, empty API key/Authorization
  and explicit model selections for every helper. Allowing built-in `opencode`
  alone would not exclude that provider's paid catalog/accounts.

## Rules, credentials and migration

BEST explicitly references the original `~/.config/opencode/AGENTS.md` because
profile XDG discovery is isolated. `OPENCODE_TEAM_RULES_FILE` selects another
existing source. Neither source is copied or written; sharing instructions does
not share provider policies, permissions, hidden harness context or accounts.

V2 stores accounts in SQLite. Its migration docs describe supported legacy auth
import, but fresh-bootstrap testing left `auth list` empty despite `auth.json`.
Check actual native accounts and prefer independent `/connect`. Native
`auth export`/`auth import` requires a **V2 Credential.Entry array**; importing the
legacy object failed with `Expected array`. No converter or automatic token copy
is installed. Protect intentional exports with 0600 permissions, never print
secrets, and do not share classic's rotating refresh token across independent
stores. Do not edit SQLite to manage accounts.

Native V2 may migrate its DB at launch. The launcher preserves the existing data
location and does not convert unknown formats; take an independent data backup.
Config rollback does not undo DB migrations. Do not run V1 against a migrated DB.

For subscription usage, choose OpenAI ChatGPT OAuth, not a separately billed API
key. Go's Console “Use balance” can spend extra credits after the allowance; the
owner must disable it there if desired. Local model/policy configuration cannot
enforce server-side billing settings or future FREE pricing/privacy.

## Official V2 sources

- [Migration](https://opencode.ai/v2/docs/migrate-v1), [configuration](https://opencode.ai/v2/docs/config), [CLI](https://opencode.ai/v2/docs/cli)
- [Agents/session models](https://opencode.ai/v2/docs/agents), [instructions](https://opencode.ai/v2/docs/instructions)
- [Providers](https://opencode.ai/v2/docs/providers), [model catalog](https://opencode.ai/v2/docs/console/models), [Go limits/balance](https://opencode.ai/v2/docs/console/go)
- [Policies](https://opencode.ai/v2/docs/policies), [permissions](https://opencode.ai/v2/docs/permissions), [MCP](https://opencode.ai/v2/docs/mcp-servers)
