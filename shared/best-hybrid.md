## BEST diff-first quality

Understand the requirement and locate reusable code with Serena; implement the
smallest compatible solution, then inspect the changed diff. Run Ruff for Python
and relevant tests/checks, not a whole-repository audit for each small fix.
When local evidence does not settle an API, native alternative, version-specific
best practice or reviewer dispute, load `documentation-lookup` for the pinned
Context7 CLI workflow. Check the project's installed version first; skip trivial
or already verified APIs. Retrieve bounded snippets, never entire manuals or
duplicate searches. No added MCP, login or paid fallback; use local evidence and
state uncertainty when documentation is unavailable.
Use CLI scanners on demand: jscpd for concrete duplication risk; Vulture for
suspected unused Python (check dynamic consumers); ast-grep for a specific structural
pattern; Semgrep for relevant security/bug patterns. Use Hadolint for changed
Dockerfiles and Trivy for relevant image, dependency or configuration changes.
Confirm reachability and meaning before acting on findings: no speculative fixes
or code/tests added merely to appease a scanner. Scanners do not detect all
overengineering. Fix verified in-scope defects immediately and rerun focused tests.

For UI/web workflow changes, use the pinned Playwright MCP in Code Mode. Its
headless isolated browser never imports personal cookies or credentials. Prefer
browser_find, semantic selectors and targeted content checks; request a small
snapshot only when needed, not screenshots or full dumps. Test local/disposable
apps, not production CRM. Close the browser in cleanup, including after errors.
If Chromium is missing, install only the official browser matching the pinned
MCP's Playwright dependency; never install/alter personal Chrome. CLI scanners
are optional host tools, not permanent MCP servers or mandatory per-request gates.

The existing read-only Reviewer must check the simplest compatible solution,
new duplication/dead code, unnecessary files/abstractions, native Django features,
functional/security regressions and actual tool/test results. Concrete safe
simplifications require correction before delivery; finish with focused tests and
minimalism review. Do not add another review system.

## BEST Hybrid: proportional native delegation

This supplement applies only to BEST. Execute the ChatGPT mandate; validate it
against real code, security and contracts rather than planning it all over again.

- Simple work: Build implements and verifies directly, without unnecessary children.
- Normal work: prefer two or three useful independent lanes when delegation helps.
- A substantial structured mandate: strongly prefer four relevant specialist lanes:
  Explore (Go MiMo) for targeted discovery; two invocations of General (Go MiniMax)
  for disjoint implementations; Specialist (Sol Medium) for critical analysis or
  a complex independent implementation. Reuse General with separate native sessions,
  not duplicated agent definitions. Preserve each role's configured model.
- Do not manufacture lanes to reach four. If fewer independent jobs exist, state
  the concrete dependency, shared-file conflict or context overhead and use fewer.
- Launch ready required lanes together as concurrent native foreground subagent
  calls in one response, so the CLI waits for their results without busywork.
  Use background only for optional non-blocking work; a required background child
  must complete before final delivery. Dependent work stays sequential;
  discovery must precede any implementation that needs its findings. An independent
  analysis may run alongside implementations only when it needs no changing files.
- Give every writer exclusive file ownership, a bounded goal, necessary context
  and acceptance tests. No concurrent edits to shared files. Build owns integration.
- After relevant implementations finish, use the independent read-only Reviewer
  (Sol Medium), then integrate corrections and run the final affected tests. Do not
  substitute the initial critical analysis for this post-implementation review.
- On a child failure, inspect its native result and recover only the unfinished
  scope through native continuation or reassignment. Report missing quota/access;
  do not add routers, mandatory gates, hooks, schedulers or paid fallbacks.
- Never deliver with required workers, post-implementation review or final tests
  pending. Recover unfinished work through native foreground continuation instead.
- If a required tool is absent, report it once and return the completed work so
  Build can run the missing check. Do not guess aliases, repeatedly probe Code
  Mode, or try import/require as an alternative shell. Use only advertised tools.

Keep context and evidence small: use Serena symbols/references before full files,
load only relevant ECC skills, and pass each child only its files, contracts and
criteria. Children return changed paths, verified findings, actual test commands,
exit codes and blockers; do not repeat project-wide discovery or copy the whole
mandate. Reuse existing test evidence unless an independent check is necessary.
Wait for native completion notifications; do not poll background children.

Build stays Sol Low. Specialist/Reviewer stay Medium; do not escalate to High/Max
without a concrete reason and authorization. Use native summary/compaction and
existing subscription connections. Report measured tokens/cache/time when useful,
but never infer monetary savings or quota remaining from model names or call counts.

## BEST strict minimalism

For every implementation, prioritize the smallest linear, readable, correct and
safe solution compatible with the request and existing contracts. Every added
line, function, class, file, layer, configuration, dependency and abstraction must
have a concrete demonstrated need. Reduce real complexity, not formatting; never
trade security, authorization, data integrity or maintainability for fewer lines.

- Before editing, locate the responsible code with Serena, check existing reuse
  and choose the simplest compatible change. Reuse prior analysis and evidence.
- Edit the existing responsible file; no new file or single-use class, service,
  facade, adapter, registry, factory, manager, decorator, wrapper, helper or layer
  without a concrete necessity. Simplify unnecessarily complex touched solutions
  at their source instead of adding compensations or broadening the refactor.
- Prefer native framework/library features: Django ORM, QuerySet, ModelForm,
  validators, constraints, permissions and transactions where applicable. Do not
  repeat guarantees of the framework or a trusted boundary; preserve distinct
  security and integrity checks. Remove duplication at its authoritative source.
- Do not duplicate authoritative data with configuration, state, dictionaries,
  flags or caches. No speculative requirements, dependencies, compatibility,
  alternative paths, silent fallbacks or defensive code without an evidenced risk.
- Keep code inspectable and linear; no convenience scaffolding, temporary helpers
  or redundant comments, logs, documentation or tests. Write a comment only when
  it states the WHY for a real invariant (domain, fiscal, security, concurrency, or a
  verified compatibility workaround) that the code cannot express; skip comments
  that restate the obvious. Do not blanket-docstring every function or private
  symbol, and no speculative TODO placeholders. Document non-obvious public
  contracts, preconditions and side effects, not signatures. Use a few focused behavioral
  regressions covering essential contracts and risks; retain necessary checks.
- Run project Ruff checks on changed Python; supplement existing docstrings with
  `ruff check --select D301,D400,D415,D419 <changed.py>` when relevant, not a D1xx
  presence blanket, separate pydocstyle dependency or blind autofix. Add docs when
  the code itself does not explain the intent, not to satisfy a linter.
  Run relevant tests, inspect the diff and
  remove introduced redundancy before delivery. For significant changes, the
  independent read-only Reviewer must explicitly check strict minimalism after
  implementation; Build must resolve concrete findings and rerun affected tests
  before delivery.

Reviewer: check native alternatives, necessity of each new file/function, existing
logic duplicated, gratuitous layers, excess complexity, redundant configuration or
data structures, gratuitous wrappers, and behavioral test value without proliferation.
Also flag comments/docstrings that are redundant, wrong or misleading, or where a real
invariant (fiscal, security, concurrency, compatibility) is left unexplained.
Report these like any other concrete finding, citing the exact file/line and the
simpler fix; they do not trigger a separate review round or endless fix cycles.
Concrete excess complexity or misleading documentation means FAIL / Request changes:
cite precise code, a simpler replacement and why it preserves requirements;
require the coder to simplify before delivery. Do not
fail changes for stylistic preference or line count alone, and do not demand fixes
for trivial or cosmetic issues. Report observed behavior separately from configured
instructions; these rules are not a universal enforcement guarantee.
