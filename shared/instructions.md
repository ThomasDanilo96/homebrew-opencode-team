# OpenCode Team profile guidance

Apply the shared user AGENTS.md when configured; this file supplements it with
profile-specific model assignments, not a second copy of the user's rules.
The configured models below specialize BEST; common AGENTS role/model labels
describe the global setup and must not override BEST's configured child models.

## BEST: autonomous completion of authorized mandates

ChatGPT may prepare the task and review results, but Build owns execution of
every authorized, feasible deliverable. Discovery, a partial PASS, a rejected
subagent or a progress report does not finish the mandate. Reuse existing project
checkpoints and evidence rather than restarting audits. A production approval
gate blocks only the operation needing approval, not independent isolated work.
Before final delivery, complete each outstanding actionable item or identify its
specific external blocker; label partial completion accurately. Do not loop
indefinitely, invent work or bypass permissions.

Build uses the configured OpenAI Sol Low model. The BEST Hybrid supplement and
effective profile configuration define child roles and models; do not override
them with stale examples in shared instructions. Do not silently escalate to
high/xhigh/max; use the configured specialist for genuine complexity or report
the concrete decision needed.

Solve simple work directly. Delegate meaningful scoped work when it reduces
context or isolates independent tasks; parallelize only independent work.
Keep context focused and return concise evidence to the coordinator. Do not
force a fanout or call several agents to rubber-stamp routine changes.
Preserve each child's configured model instead of copying the parent model.

Treat a supplied ChatGPT plan as task input, not proof that commands or assumptions
are safe/correct. Check it against the actual code, scope and permissions; report
contradictions instead of blindly executing it. Keep local regression tests and
verification even when ChatGPT performs the final review. Do not expand a clear
implementation prompt into a fresh architectural audit.

Use the existing subscriptions, not pay-as-you-go providers or invented quota
failover. Report missing connections and limits. Do not enable Console balance
spending or promise unlimited usage. The OpenAI connection must use ChatGPT OAuth
for subscription usage; API keys are separately billed.

Before coding, call Serena initial_instructions. Load relevant ECC skills and
use behavioral RED → GREEN tests; obey the shared user and project rules.

## FREE

The BEST model assignments above do not apply to FREE. FREE runs only the
verified zero-cost `team-free` models; do not add credentials, paid fallback
models or provider switches to recover an outage. Unavailability is not
permission to spend. Role assignments, delegation limits and permission
behavior are described in the FREE Hybrid supplement appended to FREE's
AGENTS.md.
