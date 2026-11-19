## FREE Hybrid: verified zero-cost models only

FREE runs exclusively on the verified `team-free` catalog: no subscription, no
paid API key, no OpenAI or Go consumption, no Console balance, no provider
fallback. Every model below answered a tool-calling probe at cost 0 and is
declared with `cost: { input: 0, output: 0 }`. Free availability is promotional
and can end without notice; unavailability is never permission to spend money
or to switch to a paid provider.

| Role | Model | Reason |
| --- | --- | --- |
| Build (coordinator), Plan, Reviewer | `team-free/deepseek-v4.1-flash-free` | Strong coding/analysis, zero retention, no training |
| Explore (read-only source analysis) | `team-free/beam-free` | 1M context, no training on inputs, text-only |
| General (independent implementation), title, summary, compaction | `team-free/mimo-v2.6-flash-free` | Proven helper already used by this profile |

`/model` may switch only inside this verified set. The
`OPENCODE_TEAM_FREE_MODEL` override accepts only `team-free/<verified id>` and
setup fails otherwise, so an unverified or paid value can never reach the
generated configuration.

### Delegation

Build owns coordination: solve simple tasks directly, delegate meaningful
scoped work to `explore` (analysis) or `general` (independent implementation).
Run at most two subagents concurrently and only for independent work; never
delegate the same files twice, never fan out to rubber-stamp a change, and
never invent extra lanes or duplicate roles. Subagents cannot spawn subagents
(`experimental.subagent_depth: 1`, children deny `subagent`). Children keep
their configured models instead of copying the parent model.

### Permissions

Ordinary work must not prompt: reads, searches, edits inside the workspace,
tests, lint/typecheck, ordinary shell commands, non-destructive git and
authorized delegation all run under native allow rules. Explicit prompts remain
for destructive commands (`rm`, `reset --hard`, `clean`, force push, rebase,
`filter-*`), any remote push (`git push ...`, force-free or not), credentials
and secrets, `sudo`/`launchctl` and infrastructure CLIs, edits under
`~/Library/LaunchAgents/*`, and every directory outside the workspace. Secret
reads (`*.env*`, `*.pem`, `*.key`, `*auth.json*`, `*credentials*`, `*secrets*`,
`*.ssh/*`, `*.aws/*`, `*.gnupg/*`, `*.netrc`) ask instead of failing. There is
no configured `*`/`*` allow wildcard and no `provider.use allow *`: rules are
appended after the OpenCode defaults and the last matching rule wins, so each
ask above overrides the default allow. Do not bypass these rules with
`opencode --auto`.

### Data handling

- DeepSeek V4.1 Flash Free: zero retention, no training; preferred coordinator.
- Beam Free: no training, 30-day retention; text-only input, no attachments.
- MiMo, Flint, Big Pickle, Iceman: feedback/improvement data may be collected —
  never paste secrets or personal data into prompts.
- Nemotron (NVIDIA trial): requests are logged; keep confidential data out.
- LongCat 2.5 Free: zero retention but 100 requests/day — not a daily driver.
- All free models are offered "for a limited time"; re-verify before relying on
  one for a long-running task.
