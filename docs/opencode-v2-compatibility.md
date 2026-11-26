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

## Session Guard — not enabled on 2.3.2

See the [separate patched prototype](session-guard-prototype.md). This section
describes the unmodified OpenCode binary, where Session Guard is still off.

OpenCode 2.3.2 can stop **server admission**, but its public TUI plugin API
cannot stop the whole **composer submission** before side effects:

- The server [`session.hook("prompt")`][prompt-hook] runs before attachment
  resolution, durable inbox admission and agent execution. A thrown error
  prevents admission in 2.3.2, but is an HTTP 500, not a typed rejection or a
  confirmation request. `context`/model hooks and execution events are later
  than admission and cannot provide this protection.
- The [native composer][composer] commits any staged revert **before** it
  sends the prompt to that hook. It can also submit pending editor context as
  a separate synthetic message first. Restoring the draft on rejection does
  not undo either operation. The normal error handler restores the draft
  only while the original composer is mounted and still empty.
- The [public TUI API][tui-api] exposes native dialogs, but does not expose
  a cancellable composer-submission callback with the exact draft, attachments
  and target session. Overriding a key binding is not a submission gate: the
  composer also calls `submit()` directly, including from its input submit
  handler. A dialog via plugin RPC could acknowledge a suspended server
  request, but cannot place the guard before the composer's revert commit.

**Native check:** two disposable BEST/FREE test roots used the installed
2.3.2 binary, separate state, and a loopback counting provider with external
network denied. In each root two ordinary prompts reached that provider
(positive control). A throw-only test plugin refused a marked prompt sent via
the native API: HTTP 500, no new inbox item, no history change, no additional
provider call. After staging a revert at the second ordinary user message,
sending the marked prompt from the native TUI also produced no inbox item or
provider call. The TUI showed a send error and restored the draft, **but
consumed the revert and removed the existing message**. No real session was
used for this test.

This violates the no-history-change requirement even with a perfect
classifier. Do not ship the throw-only probe, partially intercept Enter, or
install a warning-only plugin labelled as a guard. Revisit when OpenCode
exposes a cancellable pre-submit decision before revert/editor-context
operations, retaining the exact draft on cancellation and allowing a
one-time confirmation for that submission and session. The separate prototype
adds that decision point without changing AI Handoff.

[prompt-hook]: https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/session/prompt.ts#L34-L54
[composer]: https://github.com/anomalyco/opencode/blob/v2.3.2/packages/tui/src/component/prompt/index.tsx#L1334-L1379
[tui-api]: https://github.com/anomalyco/opencode/blob/v2.3.2/packages/plugin/src/tui/context.ts

## Official V2 sources

- [Migration](https://opencode.ai/v2/docs/migrate-v1), [configuration](https://opencode.ai/v2/docs/config), [CLI](https://opencode.ai/v2/docs/cli)
- [Agents/session models](https://opencode.ai/v2/docs/agents), [instructions](https://opencode.ai/v2/docs/instructions)
- [Providers](https://opencode.ai/v2/docs/providers), [model catalog](https://opencode.ai/v2/docs/console/models), [Go limits/balance](https://opencode.ai/v2/docs/console/go)
- [Policies](https://opencode.ai/v2/docs/policies), [permissions](https://opencode.ai/v2/docs/permissions), [MCP](https://opencode.ai/v2/docs/mcp-servers)
