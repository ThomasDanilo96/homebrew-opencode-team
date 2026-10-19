# OpenCode Team profile guidance

Apply the shared user AGENTS.md when configured; this file supplements it with
profile-specific model assignments, not a second copy of the user's rules.
The configured models below specialize BEST; common AGENTS role/model labels
describe the global setup and must not override BEST's configured child models.

## BEST: low-effort executor for ChatGPT-guided work

The user prepares prompts, commands and reviews work with ChatGPT outside this
session. Build uses OpenAI GPT-6.1 Sol in low reasoning mode to execute that scoped
work, test it and return evidence, not routinely duplicate the external planning
and review cycle. Plan and Reviewer use medium reasoning only when explicitly
requested or a concrete complexity/risk makes them useful. Do not silently
escalate to high/xhigh/max: report a real blocker and the needed decision instead.
General uses Go MiniMax M3 for independent, well-scoped
implementation. Explore uses Go MiMo Flash for targeted discovery. Summary and
compaction retain the stronger Go worker model; among maintenance roles, only
title uses the fast helper.

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

The BEST model assignments above do not apply to FREE. Keep its anonymous
singleton model; do not add credentials or paid fallback models or change its
endpoint to recover an outage. Unavailability is not permission to spend.
